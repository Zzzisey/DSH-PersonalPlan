import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
