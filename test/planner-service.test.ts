import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPlannerRepo } from '../src/db/repo.ts'
import { PlannerService } from '../src/host/planner-service.ts'
import { openForTest } from './helpers/repoHarness.ts'

test('PlannerService 默认使用内存 SQLite 的真实 PlannerRepo', () => {
  const db = openForTest()
  const repo = createPlannerRepo(db)
  const service = new PlannerService(repo)
  const goal = service.createGoal({ title: '测试目标' })
  const task = repo.createTask({ goalId: goal.id, title: '测试任务', day: '2026-11-10', estMinutes: 60 })
  assert.equal(service.updateGoal(goal.id, { status: 'done' })?.status, 'done')
  assert.deepEqual(service.queryCalendarDay('2026-11-10'), {
    day: '2026-11-10', planned: 60, limit: 240, tasks: [task],
  })
  db.close()
})
