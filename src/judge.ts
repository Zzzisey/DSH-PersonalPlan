/**
 * 语义评审（LLM-as-a-Judge）。
 *
 * 设计上把「调用模型」注入成 `JudgeChat`，这里只管提示词、解析、去重与降级判定——
 * 于是它能在没有模型的情况下被单测，而接线失败也不会拖垮 propose。
 * 口径见 DESIGN §8.2：超时或输出无法解析 → `unverified`，绝不假装审过。
 * @module @local/planner/judge
 */
import type { Issue } from './types.js'

export interface JudgeTask {
  title: string
  day?: string | undefined
  estMinutes: number
}

export interface JudgeInput {
  goal: { title: string; motivation: string | null; deadline: string | null }
  tasks: JudgeTask[]
  capacity: {
    days: Array<{ day: string; planned: number; limit: number }>
    issues: Issue[]
  }
}

/** 注入的模型调用：给定 system 与 user，返回原始文本。 */
export type JudgeChat = (system: string, user: string, signal: AbortSignal) => Promise<string>

export interface JudgeOptions {
  /** 超时毫秒，默认 8000（DESIGN §8.2）。 */
  timeoutMs?: number
  /** 最多保留多少条 issue，默认 12。 */
  maxIssues?: number
}

export type JudgeVerdict = 'pass' | 'warn' | 'fail' | 'unverified'

export interface JudgeResult {
  verdict: JudgeVerdict
  issues: Issue[]
  /** 模型原始输出，写进 check_log 便于回溯。 */
  raw: string
  /** 降级原因（超时 / 解析失败）。 */
  note?: string
}

const SYSTEM_PROMPT = [
  '你是行动计划评审员。只输出严格 JSON，不要任何解释或 markdown 代码块。',
  '按四项检查：目标覆盖（计划是否覆盖目标的关键步骤）、任务粒度、日程可行性、依赖顺序。',
  '输出：{"verdict":"pass|warn|fail","issues":[{"kind":"goal-missed|task-too-big|overload|wrong-order|vague","severity":"info|warn|fail","message":"一句话","suggestion":"具体怎么改","day":"YYYY-MM-DD 可选"}]}',
  '没有问题就返回 {"verdict":"pass","issues":[]}。',
].join('\n')

/** 拼给模型的用户消息：只送结构化输入，不送对话历史。 */
export function buildJudgePrompt(input: JudgeInput): string {
  return JSON.stringify({
    goal: input.goal,
    tasks: input.tasks,
    capacity: input.capacity,
    rules: ['目标覆盖', '任务粒度', '日程可行性', '依赖顺序'],
  }, null, 2)
}

/**
 * 解析模型输出。
 * @param raw - 模型返回的文本。
 * @param maxIssues - 最多保留条数。
 * @returns 解析成功返回 verdict 与 issues，失败返回 undefined。
 */
export function parseJudgeReply(raw: string, maxIssues = 12): { verdict: JudgeVerdict; issues: Issue[] } | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const verdict = record.verdict
  if (verdict !== 'pass' && verdict !== 'warn' && verdict !== 'fail') return undefined

  const issues: Issue[] = []
  const list = Array.isArray(record.issues) ? record.issues : []
  for (const entry of list) {
    if (issues.length >= maxIssues) break
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const message = typeof item.message === 'string' ? item.message.trim() : ''
    if (message === '') continue
    const severity = item.severity === 'fail' || item.severity === 'warn' ? item.severity : 'info'
    const kind = typeof item.kind === 'string' && item.kind !== '' ? item.kind : 'vague'
    const suggestion = typeof item.suggestion === 'string' && item.suggestion !== '' ? item.suggestion : undefined
    const day = typeof item.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.day) ? item.day : undefined
    issues.push({
      kind,
      severity,
      message,
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(day === undefined ? {} : { day }),
    })
  }
  return { verdict, issues }
}

/**
 * 丢掉与容量问题重复的条目：Judge 只负责语义，容量已经报过的不再重复。
 * @param judgeIssues - 评审给出的问题。
 * @param capacityIssues - 容量校验已给出的问题。
 */
export function dropDuplicates(judgeIssues: Issue[], capacityIssues: Issue[]): Issue[] {
  const hasOverload = capacityIssues.some((issue) => issue.kind === 'overload')
  const hasNear = capacityIssues.some((issue) => issue.kind === 'near-capacity')
  const hasTooBig = capacityIssues.some((issue) => issue.kind === 'task-too-big')
  // 目标级容量也是"装不下"，Judge 用自己的话再报一遍时同样要丢。
  const hasGoalOver = capacityIssues.some((issue) => issue.kind === 'goal-over-capacity')
  return judgeIssues.filter((issue) => {
    if (issue.kind === 'overload' && (hasOverload || hasNear || hasGoalOver)) return false
    if (issue.kind === 'goal-over-capacity' && hasGoalOver) return false
    if (issue.kind === 'task-too-big' && hasTooBig) return false
    return true
  })
}

/**
 * 合并容量结论与评审结论：任一方 fail 即 fail；否则任一方 warn 即 warn；
 * 都没有问题时，评审未完成（unverified）单独标出来。
 */
export function mergeVerdict(capacity: 'pass' | 'warn' | 'fail', judge: JudgeVerdict): JudgeVerdict {
  if (capacity === 'fail' || judge === 'fail') return 'fail'
  if (capacity === 'warn' || judge === 'warn') return 'warn'
  if (judge === 'unverified') return 'unverified'
  return 'pass'
}

/**
 * 跑一次评审。任何异常都降级为 `unverified`，不向调用方抛出。
 * @param chat - 注入的模型调用。
 * @param input - 结构化输入。
 * @param options - 超时与条数上限。
 */
export async function runJudge(chat: JudgeChat, input: JudgeInput, options: JudgeOptions = {}): Promise<JudgeResult> {
  const timeoutMs = options.timeoutMs ?? 8000
  const maxIssues = options.maxIssues ?? 12
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let raw = ''
  try {
    raw = await chat(SYSTEM_PROMPT, buildJudgePrompt(input), controller.signal)
  } catch (error) {
    return {
      verdict: 'unverified',
      issues: [],
      raw,
      note: controller.signal.aborted ? `评审超时（${timeoutMs}ms）` : `评审调用失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }

  const parsed = parseJudgeReply(raw, maxIssues)
  if (parsed === undefined) {
    return { verdict: 'unverified', issues: [], raw, note: '评审输出无法解析为约定 JSON' }
  }
  return { verdict: parsed.verdict, issues: dropDuplicates(parsed.issues, input.capacity.issues), raw }
}
