import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { test } from 'node:test'
import { proposalProjectionDefinition } from '../src/host/proposal-projection.ts'

function event(type: 'tool/call' | 'tool/result', data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data } as unknown as SessionEvent
}

function result(callId: string, value: unknown): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'message-1',
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    },
  })
}

test('Proposal 预览只从当前会话中配对的 Planner 工具结果投影', () => {
  const definition = proposalProjectionDefinition
  let state = definition.init({} as never, 0 as never)

  state = definition.apply(state, event('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-ready',
    name: 'planner_proposal_advance',
    arguments: '{}',
  }))
  state = definition.apply(state, result('call-ready', {
    status: 'ready_for_preview',
    proposalPreview: { proposalId: 'p1', token: 'signed-token' },
  }))
  assert.deepEqual(definition.wire.view(state), { proposalId: 'p1', token: 'signed-token' })

  state = definition.apply(state, result('unpaired', { proposalPreview: null }))
  assert.notEqual(definition.wire.view(state), null)

  state = definition.apply(state, event('tool/call', {
    turn: 1,
    step: 2,
    callId: 'call-editing',
    name: 'planner_proposal_advance',
    arguments: '{}',
  }))
  state = definition.apply(state, result('call-editing', { status: 'accepted' }))
  assert.equal(definition.wire.view(state), null)

  state = definition.apply(state, event('tool/call', {
    turn: 1,
    step: 3,
    callId: 'call-discard',
    name: 'planner_proposal_discard',
    arguments: '{}',
  }))
  state = definition.apply(state, result('call-discard', { status: 'discarded', proposalPreview: null }))
  assert.equal(definition.wire.view(state), null)
})
