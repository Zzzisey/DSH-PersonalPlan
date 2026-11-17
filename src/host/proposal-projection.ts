import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

export interface ProposalAccess {
  proposalId: string
  token: string
  revision: number
}

interface ProposalProjectionState {
  active: ProposalAccess | null
  pendingCalls: Record<string, true>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    plannerProposal: ProposalAccess | null
  }

  interface SessionProjectionStateMap {
    plannerProposal: ProposalProjectionState
  }
}

const accessSchema = z.object({
  proposalId: z.string().min(1),
  token: z.string().min(1),
  revision: z.number().int().nonnegative(),
}).strict()

const stateSchema = z.object({
  active: accessSchema.nullable(),
  pendingCalls: z.record(z.string(), z.literal(true)),
}).strict()

const TRACKED_TOOLS = new Set([
  'planner_proposal_advance',
  'planner_proposal_get',
  'planner_proposal_discard',
])

function projectedAccess(event: Extract<SessionEvent, { type: 'tool/result' }>): ProposalAccess | null | undefined {
  const text = event.data.message.content.find((block) => block.type === 'text')?.text
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'proposalPreview')) return undefined
    const preview = (value as { proposalPreview?: unknown }).proposalPreview
    if (preview === null) return null
    const parsed = accessSchema.safeParse(preview)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Proposal 预览在当前会话中的唯一激活来源。 */
export const proposalProjectionDefinition = {
  key: 'plannerProposal',
  stateVersion: 1,
  stateSchema,
  init: () => ({ active: null, pendingCalls: {} }),
  apply(state, event) {
    if (event.type === 'tool/call') {
      if (!TRACKED_TOOLS.has(event.data.name)) return state
      return { ...state, pendingCalls: { ...state.pendingCalls, [event.data.callId]: true } }
    }
    if (event.type === 'turn/end') {
      return Object.keys(state.pendingCalls).length === 0 ? state : { ...state, pendingCalls: {} }
    }
    if (event.type !== 'tool/result') return state

    const callId = event.data.message.source.callId
    if (!Object.hasOwn(state.pendingCalls, callId)) return state
    const pendingCalls = Object.fromEntries(
      Object.entries(state.pendingCalls).filter(([id]) => id !== callId),
    ) as Record<string, true>
    const active = projectedAccess(event)
    return active === undefined ? { ...state, pendingCalls } : { active, pendingCalls }
  },
  wire: {
    viewSchema: accessSchema.nullable(),
    view: state => state.active,
  },
} satisfies ProjectionDefinition<'plannerProposal'>
