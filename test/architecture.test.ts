import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { test } from 'node:test'

const CORE_ROOT = resolve('src/core')
const BANNED_EXTERNAL = [
  '@deepseek-ai/',
  'react',
  'node:sqlite',
  'node:http',
  'node:https',
]

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const imports: string[] = []
  const pattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) imports.push(match[1]!)
  return imports
}

test('Core 只能依赖 Core 内部文件，且不导入 DSH、SQLite、HTTP 或 React', () => {
  for (const file of sourceFiles(CORE_ROOT)) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        const outside = relative(CORE_ROOT, target)
        assert.equal(
          outside.startsWith('..') || isAbsolute(outside),
          false,
          `${relative(CORE_ROOT, file)} 不应越过 Core 边界导入 ${specifier}`,
        )
        continue
      }
      assert.equal(
        BANNED_EXTERNAL.some((prefix) => specifier === prefix || specifier.startsWith(prefix)),
        false,
        `${relative(CORE_ROOT, file)} 不应导入 ${specifier}`,
      )
    }
  }
})

test('Tool 与 Route 只通过 PlannerService 访问计划数据', () => {
  for (const file of ['src/tools.ts', 'src/api/routes.ts']) {
    const source = readFileSync(resolve(file), 'utf8')
    assert.doesNotMatch(source, /(?:db\/repo|node:sqlite)/, `${file} 必须通过 PlannerService 访问计划数据`)
  }
})

test('运行时只保留 db/repo.ts 数据访问对象，不保留 Repository 接口或转发 Adapter', () => {
  assert.equal(existsSync(resolve('src/host/repository.ts')), false)
  assert.equal(existsSync(resolve('src/host/sqlite-repository.ts')), false)

  const repoSource = readFileSync(resolve('src/db/repo.ts'), 'utf8')
  assert.match(repoSource, /export function createPlannerRepo\(/)
  assert.match(repoSource, /export type PlannerRepo = ReturnType<typeof createPlannerRepo>/)

  const serviceSource = readFileSync(resolve('src/host/planner-service.ts'), 'utf8')
  assert.match(serviceSource, /import type \{[\s\S]*PlannerRepo[\s\S]*\} from '\.\.\/db\/repo\.js'/)
  assert.doesNotMatch(serviceSource, /DatabaseSync/)

  const entrySource = readFileSync(resolve('src/index.ts'), 'utf8')
  assert.match(entrySource, /new PlannerService\(createPlannerRepo\(db\)/)
})
