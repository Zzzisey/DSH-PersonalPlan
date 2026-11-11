import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPlannerRepo } from '../src/db/repo.ts'
import { PlannerService } from '../src/host/planner-service.ts'
import { openForTest } from './helpers/repoHarness.ts'

test('create proposal advances to ready without writing formal phases or tasks', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    const service = new PlannerService(repo)
    const goal = service.createGoal({ title: '发布作品集', acceptanceCriteria: '公开链接包含三个案例', deadline: '2026-11-30' })
    const started = service.startCreateProposal('session-a', goal.id)
    assert.equal(started.stage, 'structure')

    const structured = service.advanceStructure('session-a', started.id, 0, {
      phases: [{
        title: '完成初稿', acceptanceCriteria: '三个案例均有完整初稿', seq: 1,
        tasks: [{ title: '撰写三个案例', priority: 'P0', seq: 1 }],
      }],
    })
    assert.equal(structured.status, 'accepted')
    if (structured.status !== 'accepted') return
    const taskId = structured.proposal.candidate.phases[0]!.tasks[0]!.localId
    const estimated = service.advanceEstimate('session-a', started.id, 1, { tasks: [{ taskLocalId: taskId, estMinutes: 60 }] })
    assert.equal(estimated.status, 'accepted')
    const scheduled = service.advanceSchedule('session-a', started.id, 2, {
      tasks: [{ taskLocalId: taskId, day: '2026-11-20' }], orderingConstraints: [],
    })
    assert.equal(scheduled.status, 'ready_for_preview')
    assert.equal(repo.listPhases(goal.id).length, 0)
    assert.equal(repo.listTasks({ goalId: goal.id }).length, 0)
    assert.throws(() => service.getProposal('session-b', started.id), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'PROPOSAL_OWNER_MISMATCH'
    ))
  } finally {
    db.close()
  }
})

test('proposal revision conflicts do not overwrite candidate', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    const service = new PlannerService(repo)
    const goal = service.createGoal({ title: '准备发布', acceptanceCriteria: '发布成功' })
    const proposal = service.startCreateProposal('session-a', goal.id)
    const command = {
      phases: [{ title: '准备', acceptanceCriteria: '准备完成', seq: 1, tasks: [{ title: '整理材料', priority: 'P1' as const, seq: 1 }] }],
    }
    assert.equal(service.advanceStructure('session-a', proposal.id, 0, command).status, 'accepted')
    assert.throws(() => service.advanceStructure('session-a', proposal.id, 0, command), /PROPOSAL_REVISION_CONFLICT/)
    assert.equal(service.getProposal('session-a', proposal.id).revision, 1)
  } finally {
    db.close()
  }
})

test('ready preview and commit stay consistent and stale goal changes are rejected', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    const service = new PlannerService(repo)
    const ready = (goalId: string) => {
      const started = service.startCreateProposal('session-a', goalId)
      const structured = service.advanceStructure('session-a', started.id, 0, { phases: [{ title: '交付', acceptanceCriteria: '交付验收', seq: 1, tasks: [{ title: '完成交付物', priority: 'P0', seq: 1 }] }] })
      assert.equal(structured.status, 'accepted')
      if (structured.status !== 'accepted') throw new Error('unexpected')
      const taskId = structured.proposal.candidate.phases[0]!.tasks[0]!.localId
      assert.equal(service.advanceEstimate('session-a', started.id, 1, { tasks: [{ taskLocalId: taskId, estMinutes: 45 }] }).status, 'accepted')
      const scheduled = service.advanceSchedule('session-a', started.id, 2, { tasks: [{ taskLocalId: taskId, day: '2026-11-20' }], orderingConstraints: [] })
      assert.equal(scheduled.status, 'ready_for_preview')
      if (scheduled.status !== 'ready_for_preview') throw new Error('unexpected')
      return scheduled
    }
    const goal = service.createGoal({ title: '交付项目', acceptanceCriteria: '客户验收', deadline: '2026-11-30' })
    const first = ready(goal.id)
    const preview = service.queryProposalPreview(first.previewToken, first.proposal.id, 3, '2026-11')
    assert.deepEqual(preview.diff.summary, { added: 1, removed: 0, changed: 0 })
    assert.equal(preview.diff.added[0]?.title, '完成交付物')
    assert.deepEqual(service.commitProposal(first.previewToken, first.proposal.id, 3), { phases: 1, tasks: 1, scheduleVersion: 2 })
    assert.equal(repo.listTasks({ goalId: goal.id })[0]?.title, preview.diff.added[0]?.title)
    assert.throws(() => service.commitProposal(first.previewToken, first.proposal.id, 3), /PROPOSAL_REVISION_CONFLICT|PROPOSAL_NOT_READY/)

    const secondGoal = service.createGoal({ title: '另一个交付', acceptanceCriteria: '验收完成', deadline: '2026-11-30' })
    const second = ready(secondGoal.id)
    service.updateGoal(secondGoal.id, { title: '已改变的目标' })
    assert.throws(() => service.commitProposal(second.previewToken, second.proposal.id, 3), /PROPOSAL_STALE/)
    assert.equal(repo.getProposal(second.proposal.id).status, 'stale')
    assert.equal(repo.listPhases(secondGoal.id).length, 0)
  } finally {
    db.close()
  }
})

test('two ready proposals competing for the same capacity cannot both commit', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    repo.setCapacity({ weekdayMinutes: 60, weekendMinutes: 60, overrides: {} })
    const service = new PlannerService(repo)
    const makeReady = (session: string, title: string) => {
      const goal = service.createGoal({ title, acceptanceCriteria: '完成验收', deadline: '2026-11-30' })
      const proposal = service.startCreateProposal(session, goal.id)
      const structure = service.advanceStructure(session, proposal.id, 0, { phases: [{ title: '完成', acceptanceCriteria: '完成验收', seq: 1, tasks: [{ title: `${title}任务`, priority: 'P0', seq: 1 }] }] })
      if (structure.status !== 'accepted') throw new Error('unexpected')
      const taskId = structure.proposal.candidate.phases[0]!.tasks[0]!.localId
      service.advanceEstimate(session, proposal.id, 1, { tasks: [{ taskLocalId: taskId, estMinutes: 60 }] })
      const ready = service.advanceSchedule(session, proposal.id, 2, { tasks: [{ taskLocalId: taskId, day: '2026-11-20' }], orderingConstraints: [] })
      if (ready.status !== 'ready_for_preview') throw new Error('unexpected')
      return ready
    }
    const first = makeReady('session-a', '项目一')
    const second = makeReady('session-b', '项目二')
    service.commitProposal(first.previewToken, first.proposal.id, 3)
    assert.throws(() => service.commitProposal(second.previewToken, second.proposal.id, 3), /PROPOSAL_STALE/)
    assert.equal(repo.getProposal(second.proposal.id).status, 'stale')
  } finally {
    db.close()
  }
})

test('reschedule starts at schedule and only changes candidate task days', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    const service = new PlannerService(repo)
    const goal = service.createGoal({ title: '已有计划', acceptanceCriteria: '完成计划', deadline: '2026-11-30' })
    const phase = repo.createPhase({ goalId: goal.id, title: '阶段', acceptanceCriteria: '阶段完成', seq: 1 })
    const task = repo.createTask({ goalId: goal.id, phaseId: phase.id, title: '执行', estMinutes: 30, day: '2026-11-20', seq: 1 })
    const proposal = service.startRescheduleProposal('session-a', goal.id)
    assert.equal(proposal.stage, 'schedule')
    const localId = proposal.candidate.phases[0]!.tasks[0]!.localId
    const ready = service.advanceSchedule('session-a', proposal.id, 0, { tasks: [{ taskLocalId: localId, day: '2026-11-21' }], orderingConstraints: [] })
    assert.equal(ready.status, 'ready_for_preview')
    assert.equal(repo.getTask(task.id)?.day, '2026-11-20')
    assert.equal(ready.proposal.candidate.phases[0]!.tasks[0]!.day, '2026-11-21')
    if (ready.status !== 'ready_for_preview') return
    service.commitProposal(ready.previewToken, proposal.id, 1)
    assert.equal(repo.getTask(task.id)?.day, '2026-11-21')
  } finally { db.close() }
})

test('modify starts at the earliest affected stage and commits estimate changes', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    const service = new PlannerService(repo)
    const goal = service.createGoal({ title: '修改计划', acceptanceCriteria: '完成', deadline: '2026-11-30' })
    const phase = repo.createPhase({ goalId: goal.id, title: '阶段', acceptanceCriteria: '完成阶段', seq: 1 })
    const task = repo.createTask({ goalId: goal.id, phaseId: phase.id, title: '任务', estMinutes: 30, day: '2026-11-20', seq: 1 })
    assert.equal(service.startModifyProposal('structure-session', goal.id, 'structure').stage, 'structure')
    const proposal = service.startModifyProposal('estimate-session', goal.id, 'estimate')
    const localId = proposal.candidate.phases[0]!.tasks[0]!.localId
    const estimated = service.advanceEstimate('estimate-session', proposal.id, 0, { tasks: [{ taskLocalId: localId, estMinutes: 60 }] })
    assert.equal(estimated.status, 'accepted')
    const ready = service.advanceSchedule('estimate-session', proposal.id, 1, { tasks: [{ taskLocalId: localId, day: '2026-11-20' }], orderingConstraints: [] })
    if (ready.status !== 'ready_for_preview') throw new Error('unexpected')
    service.commitProposal(ready.previewToken, proposal.id, 2)
    assert.equal(repo.getTask(task.id)?.estMinutes, 60)
  } finally { db.close() }
})

test('replan preserves completed tasks and replaces unfinished content only after confirmation', () => {
  const db = openForTest()
  try {
    const repo = createPlannerRepo(db)
    const service = new PlannerService(repo)
    const goal = service.createGoal({ title: '重新规划', acceptanceCriteria: '完成目标', deadline: '2026-11-30' })
    const phase = repo.createPhase({ goalId: goal.id, title: '现有阶段', acceptanceCriteria: '完成阶段', seq: 1 })
    const done = repo.createTask({ goalId: goal.id, phaseId: phase.id, title: '已完成', priority: 'P0', estMinutes: 30, day: '2026-11-18', seq: 1 })
    const removed = repo.createTask({ goalId: goal.id, phaseId: phase.id, title: '待替换', estMinutes: 30, day: '2026-11-20', seq: 2 })
    repo.updateTasks([{ id: done.id, status: 'done' }])
    const proposal = service.startReplanProposal('session-a', goal.id)
    const structure = service.advanceStructure('session-a', proposal.id, 0, { phases: [{
      sourcePhaseId: phase.id, title: '现有阶段', acceptanceCriteria: '完成阶段', seq: 1,
      tasks: [
        { sourceTaskId: done.id, title: '已完成', priority: 'P0', seq: 1 },
        { title: '新的任务', priority: 'P1', seq: 2 },
      ],
    }] })
    if (structure.status !== 'accepted') throw new Error('unexpected')
    const tasks = structure.proposal.candidate.phases[0]!.tasks
    const doneLocal = tasks.find((task) => task.sourceTaskId === done.id)!.localId
    const newLocal = tasks.find((task) => task.sourceTaskId === null)!.localId
    const estimate = service.advanceEstimate('session-a', proposal.id, 1, { tasks: [{ taskLocalId: doneLocal, estMinutes: 30 }, { taskLocalId: newLocal, estMinutes: 45 }] })
    assert.equal(estimate.status, 'accepted')
    const ready = service.advanceSchedule('session-a', proposal.id, 2, { tasks: [{ taskLocalId: doneLocal, day: '2026-11-18' }, { taskLocalId: newLocal, day: '2026-11-21' }], orderingConstraints: [] })
    if (ready.status !== 'ready_for_preview') throw new Error('unexpected')
    assert.notEqual(repo.getTask(removed.id), undefined)
    service.commitProposal(ready.previewToken, proposal.id, 3)
    assert.equal(repo.getTask(done.id)?.status, 'done')
    assert.equal(repo.getTask(removed.id), undefined)
    assert.equal(repo.listTasks({ goalId: goal.id }).some((task) => task.title === '新的任务'), true)
  } finally { db.close() }
})
