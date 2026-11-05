import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropDuplicates, mergeVerdict, parseJudgeReply, runJudge, type JudgeChat, type JudgeInput } from '../src/judge.ts'
import type { Issue } from '../src/types.ts'

const input: JudgeInput = {
  goal: { title: '两周拿到 3 个面试', motivation: '换工作', deadline: '2026-11-08' },
  tasks: [
    { title: '改简历', day: '2026-10-30', estMinutes: 90 },
    { title: '准备自我介绍', day: '2026-10-31', estMinutes: 45 },
  ],
  capacity: {
    days: [{ day: '2026-10-30', planned: 90, limit: 240 }],
    issues: [{ kind: 'overload', severity: 'fail', message: '10-30 超载', day: '2026-10-30' }],
  },
}

test('解析干净的 JSON', () => {
  const parsed = parseJudgeReply('{"verdict":"warn","issues":[{"kind":"vague","severity":"warn","message":"缺验收标准","suggestion":"补一条"}]}')
  assert.equal(parsed?.verdict, 'warn')
  assert.equal(parsed?.issues.length, 1)
  assert.equal(parsed?.issues[0]?.message, '缺验收标准')
})

test('容忍代码块与前后废话，只取 JSON 主体', () => {
  const parsed = parseJudgeReply('好的，评审如下：\n```json\n{"verdict":"pass","issues":[]}\n```\n以上。')
  assert.equal(parsed?.verdict, 'pass')
  assert.deepEqual(parsed?.issues, [])
})

test('无法解析时返回 undefined', () => {
  assert.equal(parseJudgeReply('我觉得这个计划还行'), undefined)
  assert.equal(parseJudgeReply('{"verdict":"maybe"}'), undefined)
})

test('丢掉与容量重复的问题', () => {
  const judgeIssues: Issue[] = [
    { kind: 'overload', severity: 'fail', message: '10-30 太满' },
    { kind: 'vague', severity: 'warn', message: '目标缺验收' },
  ]
  const kept = dropDuplicates(judgeIssues, input.capacity.issues)
  assert.deepEqual(kept.map((issue) => issue.kind), ['vague'])
})

test('verdict 合并规则', () => {
  assert.equal(mergeVerdict('fail', 'pass'), 'fail')
  assert.equal(mergeVerdict('pass', 'fail'), 'fail')
  assert.equal(mergeVerdict('warn', 'pass'), 'warn')
  assert.equal(mergeVerdict('pass', 'warn'), 'warn')
  assert.equal(mergeVerdict('pass', 'unverified'), 'unverified')
  assert.equal(mergeVerdict('pass', 'pass'), 'pass')
})

test('runJudge 正常返回并保留原始输出', async () => {
  const chat: JudgeChat = async () => '{"verdict":"warn","issues":[{"kind":"goal-missed","severity":"warn","message":"缺少投递环节"}]}'
  const result = await runJudge(chat, input)
  assert.equal(result.verdict, 'warn')
  assert.equal(result.issues.length, 1)
  assert.ok(result.raw.includes('goal-missed'))
  assert.equal(result.note, undefined)
})

test('超时降级为 unverified，且不抛错', async () => {
  const hanging: JudgeChat = (_system, _user, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const result = await runJudge(hanging, input, { timeoutMs: 10 })
  assert.equal(result.verdict, 'unverified')
  assert.ok((result.note ?? '').includes('超时'))
})

test('输出无法解析时降级为 unverified', async () => {
  const chat: JudgeChat = async () => '计划不错'
  const result = await runJudge(chat, input)
  assert.equal(result.verdict, 'unverified')
  assert.ok((result.note ?? '').includes('无法解析'))
})

test('容量已报"整体装不下"时，Judge 再报同一件事会被丢掉', () => {
  const judgeIssues: Issue[] = [
    { kind: 'overload', severity: 'fail', message: '7 个任务共 770 分钟，超过可用 720 分钟' },
    { kind: 'goal-over-capacity', severity: 'fail', message: '装不下' },
    { kind: 'vague', severity: 'warn', message: '任务标题太笼统' },
  ]
  const capacityIssues: Issue[] = [
    { kind: 'goal-over-capacity', severity: 'warn', blocking: 'decision', message: '770 > 720' },
  ]
  const kept = dropDuplicates(judgeIssues, capacityIssues)
  assert.deepEqual(kept.map((issue) => issue.kind), ['vague'])
})

test('去重后一条不剩时，fail 降为 warn，不制造"空的 fail"', async () => {
  const chat: JudgeChat = async () => '{"verdict":"fail","issues":[{"kind":"overload","severity":"fail","message":"10-30 太满"}]}'
  const result = await runJudge(chat, input)
  assert.deepEqual(result.issues, [])
  assert.equal(result.verdict, 'warn')
  assert.ok((result.note ?? '').includes('重复'))
})
