/**
 * 把 src/client.tsx 打成 DSH 浏览器端要的 ModuleLoader 形态：
 * 一个 IIFE，执行时调用 window.__ModuleLoader__.load({ id, factory })。
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const id = pkg.name

const result = await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // 用经典运行时：产物只依赖 require('react')，和 hello-world 实测过的一致。
  jsx: 'transform',
  external: ['react'],
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
${code}
    return module.exports
  },
})
`

mkdirSync('dist', { recursive: true })
writeFileSync('dist/client.js', wrapped)
console.log(`client bundle: dist/client.js (${wrapped.length} bytes, id=${id})`)
