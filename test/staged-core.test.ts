import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceProposalState, discardProposalState, reopenProposal } from '../src/core/proposal.ts'
import type { PlanProposal, ProposalSnapshotV1 } from '../src/core/types.ts'
import { validateEstimate, validateSchedule, validateStructure } from '../src/core/validation/staged.ts'

const candidate: ProposalSnapshotV1 = {
  schemaVersion: 1,
  phases: [{
    localId: 'p1', sourcePhaseId: null, title: '阶段', acceptanceCriteria: '完成', seq: 1,
    completion: { isCompleted: false, completedAt: null },
    tasks: [{
      localId: 't1', sourceTaskId: null, title: '任务', priority: 'P0', seq: 1,
      completion: { isCompleted: false, completedAt: null }, estMinutes: null, day: null, actualMinutes: null, note: null,
    }],
  }],
}

function proposal(): PlanProposal {
  return {
    id: 'x', goalId: 'g', ownerSessionId: 's', operation: 'create', stage: 'structure', status: 'editing', revision: 0,
    baseScheduleVersion: 0,
    baseline: { schemaVersion: 1, goal: { id: 'g', title: '目标', acceptanceCriteria: '完成', deadline: null, status: 'active' }, phases: [] },
    candidate: { schemaVersion: 1, phases: [] }, validation: { schemaVersion: 1, state: 'pending' },
    createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z', expiresAt: null,
  }
}

test('Proposal 合法推进到 ready，ready 不复制记录', () => {
  let value = proposal()
  value = advanceProposalState(value, 'structure', candidate, { schemaVersion: 1, state: 'evaluated', validatedRevision: 1, checkedStage: 'structure', verdict: 'valid', issues: [] }, value.updatedAt)
  assert.deepEqual({ id: value.id, stage: value.stage, revision: value.revision }, { id: 'x', stage: 'estimate', revision: 1 })
  value = advanceProposalState(value, 'estimate', candidate, { schemaVersion: 1, state: 'evaluated', validatedRevision: 2, checkedStage: 'estimate', verdict: 'valid', issues: [] }, value.updatedAt)
  value = advanceProposalState(value, 'schedule', candidate, { schemaVersion: 1, state: 'evaluated', validatedRevision: 3, checkedStage: 'schedule', verdict: 'valid', issues: [], orderingConstraints: [], capacityDays: [], scheduleVersion: 0 }, value.updatedAt)
  assert.deepEqual({ id: value.id, stage: value.stage, status: value.status, revision: value.revision }, { id: 'x', stage: 'ready', status: 'awaiting_confirmation', revision: 3 })
  assert.equal(reopenProposal(value, value.updatedAt).candidate.phases[0]!.tasks[0]!.estMinutes, null)
  assert.equal(reopenProposal({ ...value, operation: 'reschedule' }, value.updatedAt).stage, 'schedule')
  assert.equal(discardProposalState(proposal(), 'now').status, 'discarded')
})

test('结构和估时校验拒绝越界、重复与非法时长', () => {
  assert.equal(validateStructure({ phases: [] }).some((item) => item.code === 'PHASE_COUNT'), true)
  const structure = { phases: [{ title: '阶段', acceptanceCriteria: '完成', seq: 1, tasks: [{ title: '任务', priority: 'P0' as const, seq: 1 }] }] }
  assert.deepEqual(validateStructure(structure), [])
  assert.equal(validateEstimate(candidate, { tasks: [{ taskLocalId: 't1', estMinutes: 30 }] }).length, 0)
  assert.equal(validateEstimate(candidate, { tasks: [{ taskLocalId: 't1', estMinutes: 31 }] })[0]?.code, 'ESTIMATE_INVALID')
})

test('排期校验 required 跨日、容量和截止日期', () => {
  const estimated = { ...candidate, phases: [{ ...candidate.phases[0]!, tasks: [{ ...candidate.phases[0]!.tasks[0]!, estMinutes: 60 }] }] }
  const issues = validateSchedule(estimated, {
    tasks: [{ taskLocalId: 't1', day: '2026-11-12' }],
    orderingConstraints: [],
  }, { deadline: '2026-11-11', capacityFor: () => 60, externalMinutes: new Map([['2026-11-12', 30]]) })
  assert.deepEqual(issues.map((item) => item.code).sort(), ['CAPACITY_EXCEEDED', 'DEADLINE_EXCEEDED'])
})
