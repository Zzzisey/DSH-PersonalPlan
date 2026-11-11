import type { PlanProposal, PlanningStage, ProposalSnapshotV1, ProposalValidationV1 } from './types.js'

const TERMINAL = new Set(['committed', 'discarded', 'stale'])

export function advanceProposalState(
  proposal: PlanProposal,
  checkedStage: Exclude<PlanningStage, 'ready'>,
  candidate: ProposalSnapshotV1,
  validation: ProposalValidationV1,
  updatedAt: string,
): PlanProposal {
  if (TERMINAL.has(proposal.status)) throw new Error('PROPOSAL_TERMINAL')
  if (proposal.status !== 'editing' || proposal.stage !== checkedStage) throw new Error('PROPOSAL_STAGE_MISMATCH')
  const stage: PlanningStage = checkedStage === 'structure' ? 'estimate' : checkedStage === 'estimate' ? 'schedule' : 'ready'
  return {
    ...proposal,
    stage,
    status: stage === 'ready' ? 'awaiting_confirmation' : 'editing',
    revision: proposal.revision + 1,
    candidate,
    validation,
    updatedAt,
  }
}

export function reopenProposal(proposal: PlanProposal, updatedAt: string): PlanProposal {
  if (proposal.stage !== 'ready' || proposal.status !== 'awaiting_confirmation') throw new Error('PROPOSAL_NOT_READY')
  return {
    ...proposal,
    stage: 'structure',
    status: 'editing',
    revision: proposal.revision + 1,
    candidate: {
      ...proposal.candidate,
      phases: proposal.candidate.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => ({ ...task, estMinutes: null, day: null })),
      })),
    },
    validation: { schemaVersion: 1, state: 'pending' },
    updatedAt,
  }
}

export function discardProposalState(proposal: PlanProposal, updatedAt: string): PlanProposal {
  if (TERMINAL.has(proposal.status)) throw new Error('PROPOSAL_TERMINAL')
  return { ...proposal, status: 'discarded', revision: proposal.revision + 1, updatedAt }
}
