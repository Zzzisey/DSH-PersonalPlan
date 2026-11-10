/**
 * 测试用装配：内存库 + 真实 PlannerRepo。
 * 运行时只依赖 `node:sqlite` 与 src 里的类型，因此可以直接被 `--experimental-strip-types` 加载。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createPlannerRepo } from '../../src/db/repo.ts'
import { openPlannerDb } from '../../src/db/schema.ts'

export { createPlannerRepo } from '../../src/db/repo.ts'
export type { PlannerRepo } from '../../src/db/repo.ts'

/** 打开一个内存库并建好 schema。 */
export function openForTest(): DatabaseSync {
  return openPlannerDb({ dbPath: ':memory:' })
}

/** 打开内存库并返回绑定该连接的真实数据访问对象。 */
export function openRepoForTest(): { db: DatabaseSync; repo: ReturnType<typeof createPlannerRepo> } {
  const db = openForTest()
  return { db, repo: createPlannerRepo(db) }
}
