import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlanProposal } from '../src/core/types.ts'
import { PlannerStorageError } from '../src/db/repo.ts'
import { openRepoForTest } from './helpers/repoHarness.ts'

function proposal(goalId: string): PlanProposal {
  const now = '2026-11-11T00:00:00.000Z'
  return {
    id: 'proposal-1',
    goalId,
    ownerSessionId: 'session-1',
    operation: 'create',
    stage: 'structure',
    status: 'editing',
    revision: 0,
    baseScheduleVersion: 0,
    baseline: {
      schemaVersion: 1,
      goal: { id: goalId, title: '目标', acceptanceCriteria: null, deadline: null, status: 'active' },
      phases: [],
    },
    candidate: { schemaVersion: 1, phases: [] },
    validation: { schemaVersion: 1, state: 'pending' },
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof PlannerStorageError && error.code === code
}

test('Proposal 可创建、按 owner 读取并按状态查询', () => {
  const { db, repo } = openRepoForTest()
  const goal = repo.createGoal({ title: '目标' })
  const created = repo.createProposal(proposal(goal.id))
  assert.deepEqual(repo.getProposal(created.id), created)
  assert.deepEqual(repo.getProposalForOwner(created.id, 'session-1'), created)
  assert.deepEqual(repo.listProposalsByStatus('editing', 'session-1').map((item) => item.id), [created.id])
  assert.throws(() => repo.getProposalForOwner(created.id, 'session-2'), hasCode('PROPOSAL_OWNER_MISMATCH'))
  db.close()
})

test('Proposal 更新使用 expectedRevision 并拒绝旧 revision', () => {
  const { db, repo } = openRepoForTest()
  const goal = repo.createGoal({ title: '目标' })
  const created = repo.createProposal(proposal(goal.id))
  const updated = repo.updateProposal({ ...created, revision: 1, stage: 'estimate' }, 0)
  assert.equal(updated.revision, 1)
  assert.equal(updated.stage, 'estimate')
  assert.throws(() => repo.updateProposal({ ...updated, revision: 2 }, 0), hasCode('PROPOSAL_REVISION_CONFLICT'))
  db.close()
})

test('Proposal 不存在、终态和损坏 JSON 返回稳定错误', () => {
  const { db, repo } = openRepoForTest()
  const goal = repo.createGoal({ title: '目标' })
  const created = repo.createProposal(proposal(goal.id))
  assert.throws(() => repo.getProposal('missing'), hasCode('PROPOSAL_NOT_FOUND'))

  const committed = repo.updateProposal({ ...created, revision: 1, status: 'committed' }, 0)
  assert.throws(() => repo.updateProposal({ ...committed, revision: 2 }, 1), hasCode('PROPOSAL_TERMINAL'))

  db.prepare("update plan_proposal set candidate_json = '{' where id = ?").run(created.id)
  assert.throws(() => repo.getProposal(created.id), hasCode('PROPOSAL_DATA_CORRUPT'))
  db.close()
})

test('schedule_version 初始为 0，损坏值不伪装成默认值', () => {
  const { db, repo } = openRepoForTest()
  assert.equal(repo.getScheduleVersion(), 0)
  db.prepare("update planner_meta set value = 'bad' where key = 'schedule_version'").run()
  assert.throws(() => repo.getScheduleVersion(), hasCode('PROPOSAL_DATA_CORRUPT'))
  db.close()
})
