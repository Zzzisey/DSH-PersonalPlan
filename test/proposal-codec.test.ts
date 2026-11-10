import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodePlanSnapshot,
  decodeProposalSnapshot,
  decodeProposalValidation,
  encodePlanSnapshot,
  encodeProposalSnapshot,
  encodeProposalValidation,
  ProposalDataCorruptError,
} from '../src/core/proposal-codec.ts'
import type { PlanSnapshotV1, ProposalSnapshotV1, ProposalValidationV1 } from '../src/core/types.ts'

const incomplete = { isCompleted: false, completedAt: null } as const

const baseline: PlanSnapshotV1 = {
  schemaVersion: 1,
  goal: {
    id: 'g_1',
    title: '发布作品集',
    acceptanceCriteria: null,
    deadline: '2026-12-31',
    status: 'active',
  },
  phases: [{
    id: 'p_1',
    title: '完成内容',
    acceptanceCriteria: null,
    seq: 1,
    completion: { isCompleted: true, completedAt: null },
    tasks: [{
      id: 't_1',
      title: '撰写案例',
      priority: 'P0',
      estMinutes: 60,
      day: '2026-11-20',
      seq: 1,
      completion: incomplete,
      actualMinutes: null,
      note: null,
    }],
  }],
}

const candidate: ProposalSnapshotV1 = {
  schemaVersion: 1,
  phases: [{
    localId: 'phase-local-1',
    sourcePhaseId: 'p_1',
    title: '完成内容',
    acceptanceCriteria: '三个案例均可公开阅读',
    seq: 1,
    completion: incomplete,
    tasks: [{
      localId: 'task-local-1',
      sourceTaskId: 't_1',
      title: '撰写案例',
      priority: 'P0',
      seq: 1,
      completion: incomplete,
      estMinutes: null,
      day: null,
      actualMinutes: null,
      note: null,
    }],
  }],
}

const validation: ProposalValidationV1 = {
  schemaVersion: 1,
  state: 'evaluated',
  validatedRevision: 3,
  checkedStage: 'schedule',
  verdict: 'valid',
  issues: [{ code: 'BUFFER_SHORT', message: '缓冲较少', taskLocalId: 'task-local-1', day: '2026-11-20' }],
  orderingConstraints: [{
    predecessorTaskLocalId: 'task-local-1',
    successorTaskLocalId: 'task-local-2',
    strength: 'preferred',
    reason: '先完成正文',
  }],
  capacityDays: [{
    day: '2026-11-20',
    limitMinutes: 240,
    externalPlannedMinutes: 60,
    candidatePlannedMinutes: 90,
  }],
  scheduleVersion: 4,
}

test('三个 Proposal JSON codec 合法值可无损往返', () => {
  assert.deepEqual(decodePlanSnapshot(encodePlanSnapshot(baseline), 'proposal-1'), baseline)
  assert.deepEqual(decodeProposalSnapshot(encodeProposalSnapshot(candidate), 'proposal-1'), candidate)
  assert.deepEqual(decodeProposalValidation(encodeProposalValidation(validation), 'proposal-1'), validation)
  assert.deepEqual(
    decodeProposalValidation(encodeProposalValidation({ schemaVersion: 1, state: 'pending' }), 'proposal-1'),
    { schemaVersion: 1, state: 'pending' },
  )
})

test('codec 不重复承担 local id 唯一性业务校验', () => {
  const duplicateIds: ProposalSnapshotV1 = {
    ...candidate,
    phases: [{ ...candidate.phases[0]!, tasks: [candidate.phases[0]!.tasks[0]!, candidate.phases[0]!.tasks[0]!] }],
  }
  assert.deepEqual(decodeProposalSnapshot(encodeProposalSnapshot(duplicateIds), 'proposal-1'), duplicateIds)
})

test('损坏 JSON 返回稳定错误并保留列名、提案 id 与 cause', () => {
  assert.throws(() => decodePlanSnapshot('{', 'proposal-bad'), (error: unknown) => {
    assert.ok(error instanceof ProposalDataCorruptError)
    assert.equal(error.code, 'PROPOSAL_DATA_CORRUPT')
    assert.equal(error.proposalId, 'proposal-bad')
    assert.equal(error.column, 'baseline_json')
    assert.ok(error.cause instanceof SyntaxError)
    return true
  })
})

test('缺失、额外字段、非法枚举与非法日期均明确失败', () => {
  const cases: Array<() => unknown> = [
    () => decodePlanSnapshot(JSON.stringify({ ...baseline, schemaVersion: 2 }), 'proposal-bad'),
    () => decodePlanSnapshot(JSON.stringify({ ...baseline, goal: { ...baseline.goal, status: 'paused' } }), 'proposal-bad'),
    () => decodePlanSnapshot(JSON.stringify({ ...baseline, goal: { ...baseline.goal, deadline: '2026-02-30' } }), 'proposal-bad'),
    () => decodePlanSnapshot(JSON.stringify({
      ...baseline,
      phases: [{ ...baseline.phases[0]!, completion: { isCompleted: true, completedAt: 'not-a-time' } }],
    }), 'proposal-bad'),
    () => decodeProposalSnapshot(JSON.stringify({ ...candidate, contentStage: 'structure' }), 'proposal-bad'),
    () => decodeProposalSnapshot(JSON.stringify({ schemaVersion: 1 }), 'proposal-bad'),
    () => decodeProposalValidation(JSON.stringify({ ...validation, requiredStage: 'schedule' }), 'proposal-bad'),
    () => decodeProposalValidation(JSON.stringify({ ...validation, scheduleVersion: 1.5 }), 'proposal-bad'),
  ]
  for (const run of cases) {
    assert.throws(run, (error: unknown) => error instanceof ProposalDataCorruptError && error.code === 'PROPOSAL_DATA_CORRUPT')
  }
})
