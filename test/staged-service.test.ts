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
