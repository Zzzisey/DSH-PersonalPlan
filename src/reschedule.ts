/**
 * `apply_reschedule`：让模型按语义提议怎么挪，算数只负责"不越界"。
 *
 * 分工：模型决定"哪条挪到哪天、为什么"；这里校验四件事——
 * 索引合法、日期在 [today, deadline] 内、P0 不动（除非显式允许）、挪完每天不超容量。
 * @module @local/planner/reschedule
 */
import type { Issue, Priority } from './types.js'

export interface RescheduleEntry {
  /** 在扁平任务列表里的下标（phases 顺序 + loose 顺序）。 */
  index: number
  title: string
  day: string | null
  estMinutes: number
  priority: Priority
}

export interface RescheduleContext {
  entries: RescheduleEntry[]
  /** 每天的上限与当前已排（含库里已有任务）。 */
  days: Array<{ day: string; limit: number; planned: number }>
  today: string
  deadline: string | null
  /** 是否允许移动 P0，默认 false。 */
  allowP0?: boolean
}

export interface Move {
  index: number
  to: string
  reason?: string
}

export type RescheduleChat = (system: string, user: string, signal: AbortSignal) => Promise<string>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const SYSTEM_PROMPT = [
  '你是日程调整助手。任务因超容量需要挪动，请只输出严格 JSON，不要解释或代码块。',
  '要求：',
  '1. 只能移动列出的任务，用 index 指代；',
  '2. 目标日期必须在允许窗口内，且挪完后那一天不能超过上限；',
  '3. P0 任务不要移动（除非用户明确允许）；',
  '4. 优先搬动优先级低、语义上更适合换日子的任务；注意依赖顺序（前置任务不能晚于后置任务）；',
  '5. 可以少挪，但不能多挪；挪不动的就留着。',
  '输出：{"moves":[{"index":0,"to":"YYYY-MM-DD","reason":"一句话"}]}，不需要移动时返回 {"moves":[]}。',
].join('\n')

/** 拼给模型的上下文：任务、每天余量、窗口、约束。 */
export function buildReschedulePrompt(context: RescheduleContext): string {
  const free = context.days.map((day) => ({
    day: day.day,
    limit: day.limit,
    planned: day.planned,
    free: day.limit - day.planned,
  }))
  return JSON.stringify({
    today: context.today,
    deadline: context.deadline,
    allowMoveP0: context.allowP0 === true,
    tasks: context.entries.map((entry) => ({
      index: entry.index,
      title: entry.title,
      day: entry.day,
      estMinutes: entry.estMinutes,
      priority: entry.priority,
    })),
    days: free,
  }, null, 2)
}

/**
 * 解析模型输出。
 * @param raw - 模型原文。
 * @returns 移动列表；解析失败返回 undefined。
 */
export function parseMoves(raw: string): Move[] | undefined {
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
  const moves = (parsed as { moves?: unknown }).moves
  if (!Array.isArray(moves)) return undefined
  const result: Move[] = []
  for (const entry of moves) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const index = item.index
    const to = item.to
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue
    if (typeof to !== 'string' || !DATE_RE.test(to)) continue
    const reason = typeof item.reason === 'string' && item.reason !== '' ? item.reason : undefined
    result.push({ index, to, ...(reason === undefined ? {} : { reason }) })
  }
  return result
}

/**
 * 校验模型的移动方案。空数组表示全部合法。
 * @param context - 上下文（任务、余量、窗口）。
 * @param moves - 模型提议。
 */
export function verifyMoves(context: RescheduleContext, moves: readonly Move[]): Issue[] {
  const issues: Issue[] = []
  const byIndex = new Map(context.entries.map((entry) => [entry.index, entry]))
  const seen = new Set<number>()

  // 以"当前已排 + 尚未被挪走的任务"为基线，逐条应用移动。
  const planned = new Map(context.days.map((day) => [day.day, day.planned]))
  const limits = new Map(context.days.map((day) => [day.day, day.limit]))

  for (const move of moves) {
    const entry = byIndex.get(move.index)
    if (entry === undefined) {
      issues.push({ kind: 'reschedule-invalid', severity: 'warn', blocking: 'decision', message: `index ${move.index} 不在任务列表里` })
      continue
    }
    if (seen.has(move.index)) {
      issues.push({ kind: 'reschedule-invalid', severity: 'warn', blocking: 'decision', message: `「${entry.title}」被挪了不止一次` })
      continue
    }
    seen.add(move.index)

    if (entry.priority === 'P0' && context.allowP0 !== true) {
      issues.push({ kind: 'reschedule-invalid', severity: 'warn', blocking: 'decision', message: `「${entry.title}」是 P0，按规则不自动移动` })
      continue
    }
    if (move.to < context.today) {
      issues.push({ kind: 'reschedule-invalid', severity: 'warn', blocking: 'decision', message: `「${entry.title}」不能挪到过去（${move.to}）` })
      continue
    }
    if (context.deadline !== null && move.to > context.deadline) {
      issues.push({ kind: 'reschedule-invalid', severity: 'warn', blocking: 'decision', message: `「${entry.title}」不能挪到截止日之后（${move.to} > ${context.deadline}）` })
      continue
    }
    if (!limits.has(move.to)) {
      issues.push({ kind: 'reschedule-invalid', severity: 'warn', blocking: 'decision', message: `「${entry.title}」的目标日期 ${move.to} 不在可排窗口内` })
      continue
    }

    if (entry.day !== null) planned.set(entry.day, (planned.get(entry.day) ?? 0) - entry.estMinutes)
    const next = (planned.get(move.to) ?? 0) + entry.estMinutes
    const limit = limits.get(move.to) ?? 0
    if (next > limit) {
      issues.push({
        kind: 'reschedule-invalid',
        severity: 'warn',
        blocking: 'decision',
        message: `「${entry.title}」挪到 ${move.to} 后那天是 ${next}/${limit}，仍然超载`,
      })
      // 回滚这次占用，避免后续判断被污染
      if (entry.day !== null) planned.set(entry.day, (planned.get(entry.day) ?? 0) + entry.estMinutes)
      continue
    }
    planned.set(move.to, next)
  }
  return issues
}

/**
 * 把移动应用到任务列表，返回新的日期分配。
 * @param entries - 原任务。
 * @param moves - 已校验通过的移动。
 */
export function applyMoves(entries: readonly RescheduleEntry[], moves: readonly Move[]): RescheduleEntry[] {
  const byIndex = new Map(moves.map((move) => [move.index, move]))
  return entries.map((entry) => {
    const move = byIndex.get(entry.index)
    return move === undefined ? entry : { ...entry, day: move.to }
  })
}

/**
 * 跑一次"模型提议 → 算数校验"。
 * @param chat - 模型调用。
 * @param context - 上下文。
 * @param options - 超时（默认 8000ms）。
 */
export async function runReschedule(
  chat: RescheduleChat,
  context: RescheduleContext,
  options: { timeoutMs?: number } = {},
): Promise<{ moves: Move[]; issues: Issue[]; note?: string; raw: string }> {
  const timeoutMs = options.timeoutMs ?? 30000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let raw = ''
  try {
    raw = await chat(SYSTEM_PROMPT, buildReschedulePrompt(context), controller.signal)
  } catch (error) {
    return {
      moves: [],
      issues: [],
      raw,
      note: controller.signal.aborted ? `挪动提议超时（${timeoutMs}ms）` : `挪动提议失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
  const parsed = parseMoves(raw)
  if (parsed === undefined) return { moves: [], issues: [], raw, note: '挪动提议无法解析为约定 JSON' }
  return { moves: parsed, issues: verifyMoves(context, parsed), raw }
}
