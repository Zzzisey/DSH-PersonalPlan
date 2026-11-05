import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capacityBetween, checkCapacity, checkGoalCapacity, evaluatePlan, limitFor, MAX_TASK_MINUTES } from '../src/planning.ts'
import type { CapacityRules } from '../src/types.ts'

const rules: CapacityRules = { weekdayMinutes: 240, weekendMinutes: 120, overrides: { '2026-10-31': 60 } }

test('工作日的上限用 weekdayMinutes，周末用 weekendMinutes', () => {
  assert.equal(limitFor('2026-10-26', rules), 240) // 周一
  assert.equal(limitFor('2026-10-31', rules), 60) // 覆盖日优先
  assert.equal(limitFor('2026-11-01', rules), 120) // 周日
})

test('容量内、无粒度问题时为 ok', () => {
  const report = checkCapacity([{ title: '写方案', day: '2026-10-26', estMinutes: 90 }], rules)
  assert.equal(report.verdict, 'ok')
  assert.deepEqual(report.days, [{ day: '2026-10-26', planned: 90, limit: 240, load: 90 / 240 }])
  assert.equal(report.unplanned, 0)
})

test('接近上限（>=85%）为 warn，不阻塞', () => {
  const report = checkCapacity([
    { title: 'A', day: '2026-10-26', estMinutes: 120 },
    { title: 'B', day: '2026-10-26', estMinutes: 90 },
  ], rules)
  assert.equal(report.verdict, 'warn')
  const issue = report.issues.find((item) => item.kind === 'near-capacity')
  assert.equal(issue?.blocking, 'none')
})

test('超过上限但没到两倍：交给人决定，并给出超出分钟数', () => {
  const report = checkCapacity([{ title: 'A', day: '2026-10-26', estMinutes: 300 }], rules)
  assert.equal(report.verdict, 'needs_decision')
  const issue = report.issues.find((item) => item.kind === 'overload')
  assert.equal(issue?.blocking, 'decision')
  assert.ok(issue?.message.includes('超出 60 分钟'))
})

test('超过两倍或超过物理上限：直接拒绝', () => {
  const report = checkCapacity([{ title: 'A', day: '2026-10-26', estMinutes: 600 }], rules)
  assert.equal(report.verdict, 'invalid')
  assert.equal(report.issues.find((item) => item.kind === 'overload')?.blocking, 'invalid')
})

test('超过粒度上限给 task-too-big，但不阻塞', () => {
  const report = checkCapacity([{ title: '大任务', day: '2026-10-27', estMinutes: MAX_TASK_MINUTES + 30 }], {
    ...rules,
    weekdayMinutes: 600,
  })
  assert.ok(report.issues.some((issue) => issue.kind === 'task-too-big' && issue.severity === 'warn'))
  assert.equal(report.verdict, 'warn')
})

test('未排期任务计入 unplanned 并给 info', () => {
  const report = checkCapacity([{ title: '有空再说', estMinutes: 30 }], rules)
  assert.equal(report.unplanned, 1)
  assert.equal(report.verdict, 'ok', 'info 不影响 verdict')
  assert.ok(report.issues.some((issue) => issue.kind === 'unplanned'))
})

test('capacityBetween 按区间累计，周末与覆盖日都生效', () => {
  // 10-30 周五 240 + 10-31 周六（覆盖 60）+ 11-01 周日 120 = 420
  assert.equal(capacityBetween('2026-10-30', '2026-11-01', rules), 420)
  assert.equal(capacityBetween('2026-10-30', '2026-10-30', rules), 240)
  assert.equal(capacityBetween('2026-11-01', '2026-10-30', rules), 0, '反向区间为 0')
})

test('目标级容量：来得及返回 undefined', () => {
  const issue = checkGoalCapacity({
    proposedMinutes: 300,
    existingMinutes: 60,
    deadline: '2026-11-01',
    today: '2026-10-30',
    rules,
  })
  assert.equal(issue, undefined, '360 <= 420')
})

test('目标级容量：整体来不及 → 交给人决定，而不是硬拒', () => {
  const issue = checkGoalCapacity({
    proposedMinutes: 400,
    existingMinutes: 100,
    deadline: '2026-11-01',
    today: '2026-10-30',
    rules,
  })
  assert.equal(issue?.kind, 'goal-over-capacity')
  assert.equal(issue?.blocking, 'decision')
  assert.ok(issue?.message.includes('超过'))
})

test('目标级容量：无截止日不判定，截止已过 → 交给人决定', () => {
  assert.equal(checkGoalCapacity({ proposedMinutes: 999, deadline: null, today: '2026-10-30', rules }), undefined)
  const past = checkGoalCapacity({ proposedMinutes: 30, deadline: '2026-10-29', today: '2026-10-30', rules })
  assert.equal(past?.blocking, 'decision')
  assert.ok(past?.message.includes('已经过去'))
})

test('evaluatePlan 在需要决定时给三个可执行选项', () => {
  const evaluation = evaluatePlan({
    entries: [{ title: 'A', day: '2026-10-26', estMinutes: 300 }],
    rules,
    goal: { deadline: null },
    existingMinutes: 0,
    today: '2026-10-26',
  })
  assert.equal(evaluation.verdict, 'needs_decision')
  assert.deepEqual(evaluation.options.map((option) => option.code), ['accept_overload', 'apply_reschedule', 'shrink'])
})

test('evaluatePlan 合并日容量与目标级问题', () => {
  const evaluation = evaluatePlan({
    entries: [{ title: 'A', day: '2026-10-26', estMinutes: 90 }],
    rules,
    goal: { deadline: '2026-11-01' },
    existingMinutes: 1400,
    today: '2026-10-26',
  })
  assert.equal(evaluation.verdict, 'needs_decision')
  assert.ok(evaluation.issues.some((issue) => issue.kind === 'goal-over-capacity'))
  assert.equal(evaluation.options.length, 3)
})

test('evaluatePlan 在 ok 时不给选项', () => {
  const evaluation = evaluatePlan({
    entries: [{ title: 'A', day: '2026-10-26', estMinutes: 60 }],
    rules,
    goal: { deadline: '2026-11-01' },
    existingMinutes: 0,
    today: '2026-10-26',
  })
  assert.equal(evaluation.verdict, 'ok')
  assert.deepEqual(evaluation.options, [])
})
