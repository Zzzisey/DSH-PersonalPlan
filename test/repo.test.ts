import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from '../src/db/schema.ts'
import {
  appendCheck,
  createDraft,
  createGoal,
  createTask,
  getCapacity,
  getDraft,
  getTask,
  listTasks,
  openForTest,
  setDraftStatus,
  setDraftDecision,
  setDraftVerdict,
  setCapacity,
  transaction,
  updateGoal,
  updateTasks,
} from './helpers/repoHarness.ts'
import { openV1ForTest } from './helpers/schemaFixtures.ts'

test('建目标与任务后能查回来', () => {
  const db = openForTest()
  const goal = createGoal(db, { title: '拿到 offer', deadline: '2026-11-30' })
  assert.match(goal.id, /^g_[0-9a-f]{8}$/)

  const task = createTask(db, { goalId: goal.id, title: '投 3 家简历', day: '2026-10-26', estMinutes: 60, priority: 'P0' })
  assert.equal(task.status, 'todo')
  assert.equal(task.priority, 'P0')

  const listed = listTasks(db, { goalId: goal.id })
  assert.deepEqual(listed.map((item) => item.id), [task.id])
  db.close()
})

test('批量更新是单事务：任一条不存在则整批回滚', () => {
  const db = openForTest()
  const first = createTask(db, { title: 'A', day: '2026-10-26' })
  const second = createTask(db, { title: 'B', day: '2026-10-27' })

  assert.throws(
    () => updateTasks(db, [{ id: first.id, day: '2026-10-28' }, { id: 't_missing', day: '2026-10-28' }]),
    /不存在/,
  )
  assert.equal(getTask(db, first.id)?.day, '2026-10-26', '整批回滚，第一条也不该变')
  assert.equal(getTask(db, second.id)?.day, '2026-10-27')

  const updated = updateTasks(db, [{ id: first.id, day: '2026-10-28', status: 'doing' }])
  assert.equal(updated[0]?.day, '2026-10-28')
  assert.equal(updated[0]?.status, 'doing')
  db.close()
})

test('容量默认 240/120，写入后读回，范围非法会拒绝', () => {
  const db = openForTest()
  assert.deepEqual(getCapacity(db), { weekdayMinutes: 240, weekendMinutes: 120, overrides: {} })

  setCapacity(db, { weekdayMinutes: 180, weekendMinutes: 90, overrides: { '2026-10-31': 60 } })
  assert.equal(getCapacity(db).weekdayMinutes, 180)

  assert.throws(() => setCapacity(db, { weekdayMinutes: 10, weekendMinutes: 90, overrides: {} }), /30\.\.1440/)
  assert.equal(getCapacity(db).weekdayMinutes, 180, '非法写入不该生效')
  db.close()
})

test('草稿能记录 verdict 与状态', () => {
  const db = openForTest()
  const draft = createDraft(db, { mode: 'new', payload: { phases: [] } })
  assert.equal(draft.status, 'open')
  assert.equal(draft.verdict, null)

  setDraftVerdict(db, draft.id, 'warn')
  setDraftStatus(db, draft.id, 'committed')
  const stored = getDraft(db, draft.id)
  assert.equal(stored?.verdict, 'warn')
  assert.equal(stored?.status, 'committed')
  assert.ok(new Date(stored?.expiresAt ?? 0).getTime() > Date.now())
  db.close()
})

test('check_log 追加一条校验记录', () => {
  const db = openForTest()
  appendCheck(db, {
    kind: 'capacity',
    target: 'd_00000000',
    verdict: 'fail',
    issues: [{ kind: 'overload', severity: 'fail', message: '超载' }],
  })
  const row = db.prepare('select kind, target, verdict, issues_json from check_log').get() as {
    kind: string
    target: string
    verdict: string
    issues_json: string
  }
  assert.equal(row.kind, 'capacity')
  assert.equal(row.verdict, 'fail')
  assert.equal(JSON.parse(row.issues_json)[0].kind, 'overload')
  db.close()
})

test('草稿记录"需要用户决定"与选项，override 也能落日志', () => {
  const db = openForTest()
  const draft = createDraft(db, { mode: 'new', payload: { phases: [] } })
  assert.equal(draft.decisionRequired, 0)
  assert.equal(draft.optionsJson, null)

  setDraftDecision(db, draft.id, true, [{ code: 'shrink', label: '砍任务' }])
  const stored = getDraft(db, draft.id)
  assert.equal(stored?.decisionRequired, 1)
  assert.deepEqual(JSON.parse(stored?.optionsJson ?? '[]'), [{ code: 'shrink', label: '砍任务' }])

  appendCheck(db, {
    kind: 'override',
    target: draft.id,
    verdict: 'warn',
    issues: [],
    model: 'user',
  })
  const row = db.prepare("select count(*) as n from check_log where kind = 'override'").get() as { n: number }
  assert.equal(row.n, 1, 'v2 迁移后 check_log 接受 override')
  db.close()
})

test('空库创建完整 v2 schema', () => {
  const db = openForTest()
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  assert.equal(row.user_version, SCHEMA_VERSION)
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string }>)
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(tables, ['check_log', 'draft', 'goal', 'phase', 'setting', 'task'])
  const columns = db.prepare('PRAGMA table_info(draft)').all() as Array<{ name: string }>
  assert.ok(columns.some((column) => column.name === 'decision_required'))
  assert.ok(columns.some((column) => column.name === 'options_json'))
  db.close()
})

test('真实 v1 fixture 升级到 v2，并保留 draft 与 check_log', () => {
  const db = openV1ForTest()
  migrate(db)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  assert.equal(version.user_version, 2)
  const draft = db.prepare("select id,goal_id,decision_required,options_json from draft where id = 'd_v1'").get() as {
    id: string; goal_id: string; decision_required: number; options_json: string | null
  }
  assert.equal(draft.goal_id, 'g_v1')
  assert.equal(draft.decision_required, 0)
  assert.equal(draft.options_json, null)
  const log = db.prepare("select id,kind,target,verdict from check_log where target = 'd_v1'").get() as {
    id: number; kind: string; target: string; verdict: string
  }
  assert.deepEqual({ kind: log.kind, target: log.target, verdict: log.verdict }, {
    kind: 'capacity', target: 'd_v1', verdict: 'pass',
  })
  db.prepare(`insert into check_log (at,kind,target,verdict,issues_json,model)
    values ('2026-01-02T00:00:00.000Z','override','d_v1','warn','[]','user')`).run()
  assert.equal((db.prepare("select count(*) as n from check_log where kind = 'override'").get() as { n: number }).n, 1)
  db.close()
})

test('v2 真实列与 CHECK / FK 约束保持生效', () => {
  const db = openForTest()
  const columns = (table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
  assert.deepEqual(columns('goal'), ['id', 'title', 'motivation', 'deadline', 'status', 'created_at', 'updated_at'])
  assert.deepEqual(columns('phase'), ['id', 'goal_id', 'title', 'seq', 'start_day', 'end_day', 'status', 'created_at', 'updated_at'])
  assert.deepEqual(columns('task'), [
    'id', 'goal_id', 'phase_id', 'title', 'day', 'est_minutes', 'actual_minutes', 'priority', 'status', 'note', 'created_at', 'updated_at',
  ])
  assert.deepEqual(columns('draft'), [
    'id', 'goal_id', 'mode', 'payload_json', 'verdict', 'status', 'created_at', 'expires_at', 'decision_required', 'options_json',
  ])

  const stamp = '2026-01-01T00:00:00.000Z'
  assert.throws(
    () => db.prepare("insert into goal values ('g_bad','   ',null,null,'active',?,?)").run(stamp, stamp),
    /CHECK constraint failed/,
  )
  assert.throws(
    () => db.prepare("insert into phase values ('p_bad','g_missing','阶段',1,null,null,'planned',?,?)").run(stamp, stamp),
    /FOREIGN KEY constraint failed/,
  )
  assert.throws(
    () => db.prepare(`insert into task (id,title,est_minutes,priority,status,created_at,updated_at)
      values ('t_bad','任务',30,'P9','todo',?,?)`).run(stamp, stamp),
    /CHECK constraint failed/,
  )
  assert.throws(
    () => db.prepare(`insert into draft (id,mode,payload_json,status,created_at,expires_at)
      values ('d_bad','other','{}','open',?,?)`).run(stamp, stamp),
    /CHECK constraint failed/,
  )
  assert.throws(
    () => db.prepare(`insert into check_log (at,kind,target,verdict,issues_json)
      values (?,'other','x','pass','[]')`).run(stamp),
    /CHECK constraint failed/,
  )
  db.close()
})

test('transaction 回调抛错时回滚此前全部写入', () => {
  const db = openForTest()
  assert.throws(() => transaction(db, () => {
    createGoal(db, { title: '不应留下' })
    createTask(db, { title: '也不应留下' })
    throw new Error('forced failure')
  }), /forced failure/)
  assert.equal((db.prepare('select count(*) as n from goal').get() as { n: number }).n, 0)
  assert.equal((db.prepare('select count(*) as n from task').get() as { n: number }).n, 0)
  db.close()
})

test('高于插件支持版本的数据库拒绝迁移', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  assert.throws(() => migrate(db), (error: unknown) => {
    assert.ok(error instanceof SchemaTooNewError)
    assert.equal(error.dbVersion, SCHEMA_VERSION + 1)
    assert.equal(error.supportedVersion, SCHEMA_VERSION)
    return true
  })
  db.close()
})

test('修改目标：改状态/标题/截止，不碰任务；不存在返回 undefined', () => {
  const db = openForTest()
  const goal = createGoal(db, { title: '旧标题', deadline: '2026-11-01' })
  const task = createTask(db, { goalId: goal.id, title: 'A', day: '2026-11-01' })

  const updated = updateGoal(db, goal.id, { status: 'dropped', title: '新标题', deadline: '2026-12-01' })
  assert.equal(updated?.status, 'dropped')
  assert.equal(updated?.title, '新标题')
  assert.equal(updated?.deadline, '2026-12-01')
  assert.equal(getTask(db, task.id)?.title, 'A', '任务不受影响')

  assert.equal(updateGoal(db, 'g_missing', { status: 'done' }), undefined)
  db.close()
})
