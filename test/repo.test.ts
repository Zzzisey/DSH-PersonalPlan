import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  setDraftVerdict,
  setCapacity,
  updateTasks,
} from './helpers/repoHarness.ts'

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
