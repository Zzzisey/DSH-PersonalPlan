/**
 * 测试用装配：内存库 + 把 repo 的函数原样转出，避免测试文件里再写一层 import 样板。
 * 运行时只依赖 `node:sqlite` 与 src 里的类型，因此可以直接被 `--experimental-strip-types` 加载。
 */
import type { DatabaseSync } from 'node:sqlite'
import { openPlannerDb } from '../../src/db/schema.ts'

export * from '../../src/db/repo.ts'

/** 打开一个内存库并建好 schema。 */
export function openForTest(): DatabaseSync {
  return openPlannerDb({ dbPath: ':memory:' })
}
