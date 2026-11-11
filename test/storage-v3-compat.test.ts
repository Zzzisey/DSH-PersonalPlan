import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PlanProposal } from '../src/core/types.ts'
import { createPlannerRepo } from '../src/db/repo.ts'
import { migrate, openPlannerDb } from '../src/db/schema.ts'
import { createV2MigrationInputCopy } from './helpers/schemaFixtures.ts'

function ids(db: ReturnType<typeof createV2MigrationInputCopy>, table: string): string[] {
  return (db.prepare(`select id from ${table} order by id`).all() as Array<{ id: string }>).map((row) => row.id)
}

test('v2 文件副本升级到 v3 后身份、legacy 状态和查询结果不变', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'planner-v3-compat-'))
  const path = join(directory, 'planner.sqlite')
  const beforeDb = createV2MigrationInputCopy(path)
  const before = {
    goalIds: ids(beforeDb, 'goal'),
    phaseIds: ids(beforeDb, 'phase'),
    taskIds: ids(beforeDb, 'task'),
    taskStatuses: beforeDb.prepare('select id,status from task order by id').all().map((row) => ({ ...row })),
    tasks: createPlannerRepo(beforeDb).listTasks({ includeDropped: true }),
  }
  beforeDb.close()

  const db = openPlannerDb({ dbPath: path })
  context.after(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  migrate(db)
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  assert.deepEqual(ids(db, 'goal'), before.goalIds)
  assert.deepEqual(ids(db, 'phase'), before.phaseIds)
  assert.deepEqual(ids(db, 'task'), before.taskIds)
  assert.deepEqual(db.prepare('select id,status from task order by id').all().map((row) => ({ ...row })), before.taskStatuses)
  assert.deepEqual(createPlannerRepo(db).listTasks({ includeDropped: true }), before.tasks)
  assert.equal((db.prepare('select count(*) as n from phase where completed_at is not null').get() as { n: number }).n, 0)
  assert.equal((db.prepare('select count(*) as n from task where completed_at is not null').get() as { n: number }).n, 0)
})

test('task.seq 按日期、创建时间和 id 稳定回填', () => {
  const db = createV2MigrationInputCopy()
  const insert = db.prepare(`insert into task
    (id,goal_id,phase_id,title,day,est_minutes,priority,status,created_at,updated_at)
    values (?,?,?,?,?,30,'P2','todo',?,?)`)
  insert.run('t_early', 'g_active', 'p_active', '更早日期', '2026-11-11', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  insert.run('t_same_b', 'g_active', 'p_active', '同日 B', '2026-11-12', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  insert.run('t_same_a', 'g_active', 'p_active', '同日 A', '2026-11-12', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  insert.run('t_unscheduled', 'g_active', 'p_active', '未排期', null, '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  migrate(db)
  assert.deepEqual(
    db.prepare("select id,seq from task where phase_id = 'p_active' order by seq").all().map((row) => ({ ...row })),
    [
      { id: 't_early', seq: 1 },
      { id: 't_doing', seq: 2 },
      { id: 't_same_a', seq: 3 },
      { id: 't_same_b', seq: 4 },
      { id: 't_unscheduled', seq: 5 },
    ],
  )
  db.close()
})

test('V2 Proposal 不进入正式任务查询、容量或 schedule_version', () => {
  const db = createV2MigrationInputCopy()
  migrate(db)
  const repo = createPlannerRepo(db)
  const tasks = repo.listTasks({ includeDropped: true })
  const capacity = repo.getCapacity()
  const version = repo.getScheduleVersion()
  const proposal: PlanProposal = {
    id: 'proposal-isolated',
    goalId: 'g_active',
    ownerSessionId: 'session-isolated',
    operation: 'create',
    stage: 'structure',
    status: 'editing',
    revision: 0,
    baseScheduleVersion: version,
    baseline: {
      schemaVersion: 1,
      goal: { id: 'g_active', title: '进行中的目标', acceptanceCriteria: null, deadline: '2026-12-31', status: 'active' },
      phases: [],
    },
    candidate: { schemaVersion: 1, phases: [] },
    validation: { schemaVersion: 1, state: 'pending' },
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    expiresAt: null,
  }
  repo.createProposal(proposal)
  assert.deepEqual(repo.listTasks({ includeDropped: true }), tasks)
  assert.deepEqual(repo.getCapacity(), capacity)
  assert.equal(repo.getScheduleVersion(), version)
  db.close()
})
