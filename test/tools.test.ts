import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addDays, todayInShanghai } from '../src/core/validation/capacity.ts'
import {
  createGoal,
  getDraft,
  listPhases,
  listTasks,
  openForTest,
} from './helpers/repoHarness.ts'
import { createToolHarness } from './helpers/toolHarness.ts'

function text(value: unknown): string {
  assert.equal(typeof value, 'string')
  return value as string
}

function onlyDraftId(db: ReturnType<typeof openForTest>): string {
  const rows = db.prepare('select id from draft order by created_at, id').all() as Array<{ id: string }>
  assert.equal(rows.length, 1)
  return rows[0]!.id
}

function phase(day: string, minutes: number[] = [60]): unknown[] {
  return [{
    title: '准备阶段',
    tasks: minutes.map((estMinutes, index) => ({
      title: `任务 ${index + 1}`,
      day,
      est_minutes: estMinutes,
      priority: 'P2',
    })),
  }]
}

test('legacy Tool 名称、关键参数与字符串输出契约保持不变', () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    assert.deepEqual(harness.definitions.map((tool) => tool.name), [
      'planner_goal_create',
      'planner_goal_update',
      'planner_plan_propose',
      'planner_plan_commit',
      'planner_task_query',
      'planner_task_update',
      'planner_plan_overview',
    ])
    const propose = harness.tool('planner_plan_propose')
    assert.deepEqual((propose.parameters as { required?: string[] }).required, ['goal_id', 'phases'])
    assert.equal((propose.output.schema as { type?: string }).type, 'string')
    const commit = harness.tool('planner_plan_commit')
    assert.deepEqual((commit.parameters as { required?: string[] }).required, ['draft_id'])
  } finally {
    db.close()
  }
})

test('goal create / update 持久化现有字段并拒绝非法输入', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    const created = text(await harness.run('planner_goal_create', {
      title: '完成作品集',
      motivation: '求职',
      deadline: '2026-12-31',
    }))
    assert.match(created, /已创建目标/)
    const goal = db.prepare("select id,title,motivation,deadline,status from goal where title = '完成作品集'").get() as {
      id: string; title: string; motivation: string; deadline: string; status: string
    }
    assert.equal(goal.motivation, '求职')
    assert.equal(goal.deadline, '2026-12-31')
    assert.equal(goal.status, 'active')

    const updated = text(await harness.run('planner_goal_update', {
      goal_id: goal.id,
      title: '发布作品集',
      status: 'done',
      deadline: '',
    }))
    assert.match(updated, /任务未做任何改动/)
    const stored = db.prepare('select title,deadline,status from goal where id = ?').get(goal.id) as {
      title: string; deadline: string | null; status: string
    }
    assert.deepEqual({ ...stored }, { title: '发布作品集', deadline: null, status: 'done' })

    assert.match(text(await harness.run('planner_goal_create', { title: '坏日期', deadline: '12/31' })), /^错误：/)
    assert.match(text(await harness.run('planner_goal_update', { goal_id: goal.id })), /^错误：/)
  } finally {
    db.close()
  }
})

test('legacy propose 写同一份旧 draft，正式 phase/task 在 commit 前保持为空', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    const goal = createGoal(db, { title: '完成作品集', deadline: addDays(todayInShanghai(), 30) })
    const day = addDays(todayInShanghai(), 1)
    const proposed = text(await harness.run('planner_plan_propose', {
      goal_id: goal.id,
      phases: phase(day),
      mode: 'new',
    }))
    assert.match(proposed, /提案已生成/)
    const draftId = onlyDraftId(db)
    const draft = getDraft(db, draftId)!
    assert.equal(draft.status, 'open')
    assert.equal(draft.goalId, goal.id)
    assert.equal(listPhases(db, goal.id).length, 0)
    assert.equal(listTasks(db, { goalId: goal.id }).length, 0)

    const revised = text(await harness.run('planner_plan_propose', {
      goal_id: goal.id,
      phases: phase(day, [75]),
      draft_id: draftId,
    }))
    assert.match(revised, new RegExp(draftId))
    assert.equal((db.prepare('select count(*) as n from draft').get() as { n: number }).n, 1)
    const payload = JSON.parse(getDraft(db, draftId)!.payloadJson) as { phases: Array<{ tasks: Array<{ estMinutes: number }> }> }
    assert.equal(payload.phases[0]!.tasks[0]!.estMinutes, 75)
    assert.equal(listPhases(db, goal.id).length, 0)
  } finally {
    db.close()
  }
})

test('invalid legacy propose 被拒绝并把旧 draft 标为 discarded', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    const goal = createGoal(db, { title: '非法计划' })
    const result = text(await harness.run('planner_plan_propose', {
      goal_id: goal.id,
      phases: phase(addDays(todayInShanghai(), 1), [800]),
    }))
    assert.match(result, /^错误：提案有结构性错误/)
    const draft = getDraft(db, onlyDraftId(db))!
    assert.equal(draft.status, 'discarded')
    assert.equal(draft.verdict, null)
    const check = db.prepare("select verdict from check_log where target = ? and kind = 'capacity'").get(draft.id) as { verdict: string }
    assert.equal(check.verdict, 'fail')
    assert.equal(listTasks(db, { goalId: goal.id }).length, 0)
  } finally {
    db.close()
  }
})

test('decision 分支要求用户选择；accept_overload 后原子提交且重复 commit 被拒绝', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    const goal = createGoal(db, { title: '容量决策', deadline: addDays(todayInShanghai(), 30) })
    const proposed = text(await harness.run('planner_plan_propose', {
      goal_id: goal.id,
      phases: phase(addDays(todayInShanghai(), 1), [120, 120, 120]),
    }))
    assert.match(proposed, /结论 needs_decision/)
    const draftId = onlyDraftId(db)
    const draft = getDraft(db, draftId)!
    assert.equal(draft.decisionRequired, 1)
    assert.deepEqual(
      (JSON.parse(draft.optionsJson ?? '[]') as Array<{ code: string }>).map((option) => option.code),
      ['accept_overload', 'apply_reschedule', 'shrink'],
    )

    const refused = text(await harness.run('planner_plan_commit', { draft_id: draftId }))
    assert.match(refused, /^错误：这份草稿需要用户决定/)
    assert.equal(listPhases(db, goal.id).length, 0)

    const committed = text(await harness.run('planner_plan_commit', {
      draft_id: draftId,
      decision: 'accept_overload',
      reason: '用户明确接受',
    }))
    assert.match(committed, /已落库：1 个阶段、3 个任务/)
    assert.equal(listPhases(db, goal.id).length, 1)
    assert.equal(listTasks(db, { goalId: goal.id }).length, 3)
    assert.equal(getDraft(db, draftId)?.status, 'committed')
    assert.equal((db.prepare("select count(*) as n from check_log where target = ? and kind = 'override'").get(draftId) as { n: number }).n, 1)
    assert.equal((db.prepare("select count(*) as n from check_log where target = ? and kind = 'commit'").get(draftId) as { n: number }).n, 1)

    assert.match(text(await harness.run('planner_plan_commit', { draft_id: draftId })), /不能重复提交/)
    assert.equal(listTasks(db, { goalId: goal.id }).length, 3)
  } finally {
    db.close()
  }
})

test('apply_reschedule 使用固定模型结果，只移动指定任务后再提交', async () => {
  const db = openForTest()
  try {
    const day = addDays(todayInShanghai(), 1)
    const movedDay = addDays(todayInShanghai(), 2)
    const harness = createToolHarness(db, {
      rescheduleChat: async () => JSON.stringify({ moves: [{ index: 2, to: movedDay, reason: '腾出容量' }] }),
    })
    const goal = createGoal(db, { title: '自动挪排期', deadline: addDays(todayInShanghai(), 7) })
    await harness.run('planner_plan_propose', { goal_id: goal.id, phases: phase(day, [120, 120, 120]) })
    const draftId = onlyDraftId(db)
    const result = text(await harness.run('planner_plan_commit', {
      draft_id: draftId,
      decision: 'apply_reschedule',
    }))
    assert.match(result, /挪动：/)
    const tasks = listTasks(db, { goalId: goal.id })
    assert.equal(tasks.filter((task) => task.day === day).length, 2)
    assert.equal(tasks.filter((task) => task.day === movedDay).length, 1)
    assert.equal(tasks.find((task) => task.title === '任务 3')?.day, movedDay)
  } finally {
    db.close()
  }
})

test('配置 Judge 时 semantic 结果写入旧 check_log', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db, {
      judgeChat: async () => '{"verdict":"warn","issues":[{"kind":"vague","severity":"warn","message":"任务略笼统"}]}',
      judgeModel: 'test/model',
    })
    const goal = createGoal(db, { title: '语义评审' })
    const result = text(await harness.run('planner_plan_propose', {
      goal_id: goal.id,
      phases: phase(addDays(todayInShanghai(), 1)),
    }))
    assert.match(result, /结论 warn/)
    const row = db.prepare("select verdict,model from check_log where kind = 'semantic'").get() as { verdict: string; model: string }
    assert.deepEqual({ ...row }, { verdict: 'warn', model: 'test/model' })
  } finally {
    db.close()
  }
})

test('过期 legacy draft 拒绝 commit 且不写正式数据', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    const goal = createGoal(db, { title: '过期草稿' })
    await harness.run('planner_plan_propose', {
      goal_id: goal.id,
      phases: phase(addDays(todayInShanghai(), 1)),
    })
    const draftId = onlyDraftId(db)
    db.prepare("update draft set expires_at = '2000-01-01T00:00:00.000Z' where id = ?").run(draftId)
    assert.match(text(await harness.run('planner_plan_commit', { draft_id: draftId })), /草稿已过期/)
    assert.equal(getDraft(db, draftId)?.status, 'open')
    assert.equal(listPhases(db, goal.id).length, 0)
    assert.equal(listTasks(db, { goalId: goal.id }).length, 0)
  } finally {
    db.close()
  }
})

test('legacy commit 中途违反约束时 Phase、Task 与 draft 状态全部回滚', async () => {
  const db = openForTest()
  try {
    const harness = createToolHarness(db)
    const goal = createGoal(db, { title: '事务回滚' })
    const day = addDays(todayInShanghai(), 1)
    await harness.run('planner_plan_propose', { goal_id: goal.id, phases: phase(day) })
    const draftId = onlyDraftId(db)
    const payload = JSON.parse(getDraft(db, draftId)!.payloadJson) as {
      phases: Array<{ tasks: Array<Record<string, unknown>> }>
    }
    payload.phases[0]!.tasks.push({ title: '   ', day, estMinutes: 30, priority: 'P2' })
    db.prepare('update draft set payload_json = ? where id = ?').run(JSON.stringify(payload), draftId)

    await assert.rejects(harness.run('planner_plan_commit', { draft_id: draftId }), /CHECK constraint failed/)
    assert.equal(listPhases(db, goal.id).length, 0)
    assert.equal(listTasks(db, { goalId: goal.id }).length, 0)
    assert.equal(getDraft(db, draftId)?.status, 'open')
    assert.equal((db.prepare("select count(*) as n from check_log where target = ? and kind = 'commit'").get(draftId) as { n: number }).n, 0)
  } finally {
    db.close()
  }
})
