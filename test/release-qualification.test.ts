import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPlannerRepo } from '../src/db/repo.ts'
import { openPlannerDb } from '../src/db/schema.ts'
import { PlannerService } from '../src/host/planner-service.ts'
import { createPlannerTools } from '../src/tools.ts'
import { createV2MigrationInputCopy } from './helpers/schemaFixtures.ts'

test('release tool selection keeps planning workflows exclusive and formal-data tools shared', () => {
  const db = openPlannerDb({ dbPath: ':memory:' })
  try {
    const service = new PlannerService(createPlannerRepo(db))
    const staged = createPlannerTools(service, 'staged').map((tool) => tool.name)
    const defaults = createPlannerTools(service).map((tool) => tool.name)
    const legacy = createPlannerTools(service, 'legacy').map((tool) => tool.name)
    assert.deepEqual(staged.filter((name) => ['planner_plan_create', 'planner_plan_reschedule', 'planner_plan_modify', 'planner_plan_replan'].includes(name)), [
      'planner_plan_create', 'planner_plan_reschedule', 'planner_plan_modify', 'planner_plan_replan',
    ])
    assert.equal(staged.includes('planner_plan_propose'), false)
    assert.deepEqual(defaults, staged)
    assert.equal(legacy.includes('planner_plan_propose'), true)
    assert.equal(legacy.includes('planner_plan_create'), false)
    for (const name of ['planner_goal_update', 'planner_task_query', 'planner_task_update', 'planner_plan_overview']) {
      assert.equal(staged.includes(name), true)
      assert.equal(legacy.includes(name), true)
    }
  } finally { db.close() }
})

test('compatible database backup can be restored after migration rehearsal', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'planner-release-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, 'source.sqlite')
  const backup = join(directory, 'backup.sqlite')
  const restored = join(directory, 'restored.sqlite')
  const before = createV2MigrationInputCopy(source)
  const expected = before.prepare('select id from task order by id').all().map((row) => ({ ...row }))
  before.close()
  copyFileSync(source, backup)
  const migrated = openPlannerDb({ dbPath: source })
  migrated.close()
  copyFileSync(backup, restored)
  const recovered = openPlannerDb({ dbPath: restored })
  assert.equal((recovered.prepare('pragma integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  assert.deepEqual(recovered.prepare('select id from task order by id').all().map((row) => ({ ...row })), expected)
  recovered.close()
})
