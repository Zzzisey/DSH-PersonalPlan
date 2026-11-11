import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cropDiff, diffPlan } from '../src/core/diff.ts'
import type { PlanSnapshotV1, ProposalSnapshotV1 } from '../src/core/types.ts'

test('proposal diff uses ids and represents changes as removed plus added', () => {
  const baseline: PlanSnapshotV1 = { schemaVersion: 1, goal: { id: 'g', title: 'G', acceptanceCriteria: 'A', deadline: null, status: 'active' }, phases: [{ id: 'p', title: 'P', acceptanceCriteria: 'A', seq: 1, completion: { isCompleted: false, completedAt: null }, tasks: [{ id: 't1', title: 'Same title', priority: 'P1', estMinutes: 30, day: '2026-11-10', seq: 1, completion: { isCompleted: false, completedAt: null }, actualMinutes: null, note: null }] }] }
  const candidate: ProposalSnapshotV1 = { schemaVersion: 1, phases: [{ localId: 'p-local', sourcePhaseId: 'p', title: 'P', acceptanceCriteria: 'A', seq: 1, completion: { isCompleted: false, completedAt: null }, tasks: [{ localId: 't-local', sourceTaskId: 't1', title: 'Same title', priority: 'P1', estMinutes: 30, day: '2026-11-12', seq: 1, completion: { isCompleted: false, completedAt: null }, actualMinutes: null, note: null }] }] }
  const diff = diffPlan(baseline, candidate)
  assert.deepEqual(diff.summary, { added: 0, removed: 0, changed: 1 })
  assert.equal(cropDiff(diff, '2026-11-12', '2026-11-12').added.length, 1)
  assert.equal(cropDiff(diff, '2026-11-12', '2026-11-12').removed.length, 0)
})
