import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { getCapacity } from './helpers/repoHarness.ts'
import { createV2MigrationInputCopy } from './helpers/schemaFixtures.ts'

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>)
    .map((row) => row.name)
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

function values(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ value: string }>).map((row) => row.value)
}

test('v2 迁移输入锁定当前表、列与 user_version，尚无 Proposal Storage', () => {
  const db = createV2MigrationInputCopy()
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
  assert.deepEqual(tableNames(db), ['check_log', 'draft', 'goal', 'phase', 'setting', 'task'])

  assert.deepEqual(columnNames(db, 'goal'), [
    'id', 'title', 'motivation', 'deadline', 'status', 'created_at', 'updated_at',
  ])
  assert.deepEqual(columnNames(db, 'phase'), [
    'id', 'goal_id', 'title', 'seq', 'start_day', 'end_day', 'status', 'created_at', 'updated_at',
  ])
  assert.deepEqual(columnNames(db, 'task'), [
    'id', 'goal_id', 'phase_id', 'title', 'day', 'est_minutes', 'actual_minutes', 'priority', 'status', 'note', 'created_at', 'updated_at',
  ])
  assert.equal(tableNames(db).includes('plan_proposal'), false)
  assert.equal(tableNames(db).includes('planner_meta'), false)
  assert.equal(columnNames(db, 'goal').includes('acceptance_criteria'), false)
  assert.equal(columnNames(db, 'phase').includes('acceptance_criteria'), false)
  assert.equal(columnNames(db, 'phase').includes('completed_at'), false)
  assert.equal(columnNames(db, 'task').includes('seq'), false)
  assert.equal(columnNames(db, 'task').includes('completed_at'), false)
  db.close()
})

test('v2 迁移输入锁定正式对象 id、数量与全部 legacy 状态', () => {
  const db = createV2MigrationInputCopy()
  assert.deepEqual(values(db, 'select id as value from goal order by id'), ['g_active', 'g_done', 'g_dropped'])
  assert.deepEqual(values(db, 'select id as value from phase order by id'), ['p_active', 'p_done', 'p_dropped', 'p_planned'])
  assert.deepEqual(values(db, 'select id as value from task order by id'), ['t_doing', 't_done', 't_dropped', 't_loose', 't_todo'])

  assert.deepEqual(values(db, 'select status as value from goal order by status'), ['active', 'done', 'dropped'])
  assert.deepEqual(values(db, 'select status as value from phase order by status'), ['active', 'done', 'dropped', 'planned'])
  assert.deepEqual(values(db, 'select status as value from task order by status'), ['doing', 'done', 'dropped', 'todo', 'todo'])
  assert.deepEqual(values(db, 'select status as value from draft order by status'), ['committed', 'discarded', 'open'])

  assert.deepEqual({
    goals: (db.prepare('select count(*) as n from goal').get() as { n: number }).n,
    phases: (db.prepare('select count(*) as n from phase').get() as { n: number }).n,
    tasks: (db.prepare('select count(*) as n from task').get() as { n: number }).n,
    drafts: (db.prepare('select count(*) as n from draft').get() as { n: number }).n,
    checks: (db.prepare('select count(*) as n from check_log').get() as { n: number }).n,
    settings: (db.prepare('select count(*) as n from setting').get() as { n: number }).n,
  }, { goals: 3, phases: 4, tasks: 5, drafts: 3, checks: 4, settings: 2 })
  db.close()
})

test('v2 迁移输入锁定 setting 读取与 decision/override 数据', () => {
  const db = createV2MigrationInputCopy()
  assert.deepEqual(getCapacity(db), {
    weekdayMinutes: 300,
    weekendMinutes: 150,
    overrides: { '2026-11-14': 90 },
  })
  assert.equal(
    (db.prepare("select value from setting where key = 'fixture_marker'").get() as { value: string }).value,
    '"v2-migration-input"',
  )
  const draft = db.prepare("select decision_required, options_json from draft where id = 'd_open'").get() as {
    decision_required: number
    options_json: string
  }
  assert.equal(draft.decision_required, 1)
  assert.equal(draft.options_json, '[{"code":"shrink","label":"缩减任务"}]')
  assert.equal((db.prepare("select count(*) as n from check_log where kind = 'override'").get() as { n: number }).n, 1)
  db.close()
})

test('v2 fixture 可重复生成相同逻辑数据库副本', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'planner-v2-input-'))
  const first = createV2MigrationInputCopy(join(directory, 'first.sqlite'))
  const second = createV2MigrationInputCopy(join(directory, 'second.sqlite'))
  context.after(() => {
    first.close()
    second.close()
    rmSync(directory, { recursive: true, force: true })
  })

  for (const table of tableNames(first)) {
    const firstRows = first.prepare(`select * from ${table} order by rowid`).all()
    const secondRows = second.prepare(`select * from ${table} order by rowid`).all()
    assert.deepEqual(secondRows, firstRows, `${table} 的逻辑内容应可重复`)
  }
})
