import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMoves, parseMoves, verifyMoves, type RescheduleContext } from '../src/reschedule.ts'

const context: RescheduleContext = {
  entries: [
    { index: 0, title: '整理笔记', day: '2026-11-05', estMinutes: 60, priority: 'P2' },
    { index: 1, title: '模拟面试', day: '2026-11-05', estMinutes: 60, priority: 'P0' },
  ],
  days: [
    { day: '2026-11-05', limit: 240, planned: 300 },
    { day: '2026-11-06', limit: 240, planned: 60 },
  ],
  today: '2026-11-05',
  deadline: '2026-11-10',
}

test('合法移动通过：目标日放得下', () => {
  assert.deepEqual(verifyMoves(context, [{ index: 0, to: '2026-11-06' }]), [])
})

test('P0 默认不许挪', () => {
  const issues = verifyMoves(context, [{ index: 1, to: '2026-11-06' }])
  assert.equal(issues.length, 1)
  assert.ok(issues[0]?.message.includes('P0'))
})

test('挪到放不下的日子会被拒', () => {
  const tight: RescheduleContext = {
    ...context,
    days: [
      { day: '2026-11-05', limit: 240, planned: 300 },
      { day: '2026-11-06', limit: 240, planned: 220 },
    ],
  }
  const issues = verifyMoves(tight, [{ index: 0, to: '2026-11-06' }])
  assert.ok(issues.some((issue) => issue.message.includes('仍然超载')))
})

test('不能挪到过去或截止日之后', () => {
  assert.ok(verifyMoves(context, [{ index: 0, to: '2026-11-04' }]).some((issue) => issue.message.includes('过去')))
  assert.ok(verifyMoves(context, [{ index: 0, to: '2026-11-20' }]).some((issue) => issue.message.includes('截止日之后')))
})

test('parseMoves 容忍前后废话，丢弃非法项', () => {
  const moves = parseMoves('好的：\n{"moves":[{"index":0,"to":"2026-11-06"},{"index":"x","to":"2026-11-06"}]}')
  assert.deepEqual(moves, [{ index: 0, to: '2026-11-06' }])
  assert.equal(parseMoves('挪不了'), undefined)
})

test('applyMoves 只改被移动的那几条', () => {
  const moved = applyMoves(context.entries, [{ index: 0, to: '2026-11-06' }])
  assert.equal(moved[0]?.day, '2026-11-06')
  assert.equal(moved[1]?.day, '2026-11-05')
})
