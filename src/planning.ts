/**
 * 容量校验：纯函数，不读库、不发请求。阈值与判定口径见 DESIGN §8.1。
 * @module @local/planner/planning
 */
import type { CapacityRules, DayLoad, Issue } from './types.js'

/** 单任务粒度上限（分钟）；超过就建议再拆。 */
export const MAX_TASK_MINUTES = 120

/** 单日物理上限（分钟）；超过视为数据错误，而不是权衡。 */
export const MAX_DAY_MINUTES = 720

/** 一条问题的处置方式：只提示 / 需要用户决定 / 直接拒绝。 */
export type Blocking = 'none' | 'decision' | 'invalid'

/** 计划结论：拒绝 / 需用户决定 / 有警告但可提交 / 没问题。 */
export type PlanVerdict = 'invalid' | 'needs_decision' | 'warn' | 'ok'

/** 给用户的可执行选项（HITL）。 */
export interface DecisionOption {
  code: 'accept_overload' | 'apply_reschedule' | 'shrink'
  label: string
}

/** 一次完整评估的结果。 */
export interface PlanEvaluation {
  verdict: PlanVerdict
  issues: Issue[]
  days: DayLoad[]
  unplanned: number
  options: DecisionOption[]
}

/** 接近上限的告警线：`load >= 0.85` 即 warn。 */
const WARN_RATIO = 0.85

/** 一个待校验项；`day` 为空表示未排期。 */
export interface PlanEntry {
  title: string
  day?: string | null | undefined
  estMinutes: number
}

export interface CapacityReport {
  verdict: PlanVerdict
  issues: Issue[]
  days: DayLoad[]
  /** 未排期任务数（`day` 为空）。 */
  unplanned: number
}

/**
 * 某天的容量上限：先看 overrides，再按周末/工作日取默认值。
 * @param day - `YYYY-MM-DD`。
 * @param rules - 容量规则。
 * @returns 该日上限（分钟）。
 */
export function limitFor(day: string, rules: CapacityRules): number {
  const override = rules.overrides[day]
  if (override !== undefined) return override
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return weekday === 0 || weekday === 6 ? rules.weekendMinutes : rules.weekdayMinutes
}

/**
 * 今天的日期（固定 Asia/Shanghai），`YYYY-MM-DD`。
 * @returns 日期字符串。
 */
export function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/**
 * 日期加减天数。
 * @param day - `YYYY-MM-DD`。
 * @param amount - 天数，可为负。
 * @returns 新日期。
 */
export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

/**
 * 某月的日历网格：固定 42 天，周一开头。
 * @param month - `YYYY-MM`。
 * @returns 42 个 `YYYY-MM-DD`，含前后补齐的上/下月日期。
 * @throws 当 month 不是 `YYYY-MM` 时。
 */
export function monthGrid(month: string): string[] {
  const [yearRaw, monthRaw] = month.split('-')
  const year = Number(yearRaw)
  const index = Number(monthRaw)
  if (!Number.isInteger(year) || !Number.isInteger(index) || index < 1 || index > 12) {
    throw new Error(`月份格式应为 YYYY-MM：${month}`)
  }
  const first = new Date(Date.UTC(year, index - 1, 1))
  const start = new Date(first)
  start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, offset) => {
    const date = new Date(start)
    date.setUTCDate(start.getUTCDate() + offset)
    return date.toISOString().slice(0, 10)
  })
}

/**
 * 区间内可用容量合计（分钟）。
 * @param from - 起始日 `YYYY-MM-DD`。
 * @param to - 结束日（含）。
 * @param rules - 容量规则。
 * @returns 合计分钟数；`from > to` 时为 0。
 */
export function capacityBetween(from: string, to: string, rules: CapacityRules): number {
  let total = 0
  for (let day = from; day <= to; day = addDays(day, 1)) total += limitFor(day, rules)
  return total
}

/**
 * 目标级容量：截止日前还剩多少可用时间，够不够装下这个目标剩下的活。
 *
 * 日容量校验只能发现"某天超了"，发现不了"每天都排得下、但整体来不及"。
 * @param input - 提案分钟数、已有未完成分钟数、截止日、今天、容量规则。
 * @returns 一条 fail 级 issue，或 undefined（来得及 / 无截止日）。
 */
export function checkGoalCapacity(input: {
  proposedMinutes: number
  existingMinutes?: number
  deadline: string | null
  today: string
  rules: CapacityRules
}): Issue | undefined {
  const { deadline, today, rules } = input
  const total = input.proposedMinutes + (input.existingMinutes ?? 0)
  if (deadline === null) return undefined
  if (deadline < today) {
    return total <= 0 ? undefined : {
      kind: 'goal-over-capacity',
      severity: 'warn',
      blocking: 'decision',
      message: `截止日期 ${deadline} 已经过去，但还有 ${total} 分钟未完成`,
      suggestion: '把截止日期改到未来，或把剩余任务标为放弃',
    }
  }
  const usable = capacityBetween(today, deadline, rules)
  if (total <= usable) return undefined
  return {
    kind: 'goal-over-capacity',
    severity: 'warn',
    blocking: 'decision',
    message: `目标剩余 ${total} 分钟（本次提案 ${input.proposedMinutes}${input.existingMinutes === undefined ? '' : ` + 已排 ${input.existingMinutes}`}），超过 ${today} 到 ${deadline} 的可用 ${usable} 分钟`,
    suggestion: '砍掉次要任务或缩小范围；也可以把截止日期后移',
  }
}

/**
 * 由问题清单推出结论。
 * @param issues - 全部问题。
 * @returns 取最严重的一档。
 */
export function verdictOf(issues: readonly Issue[]): PlanVerdict {
  if (issues.some((issue) => issue.blocking === 'invalid')) return 'invalid'
  if (issues.some((issue) => issue.blocking === 'decision')) return 'needs_decision'
  if (issues.some((issue) => issue.severity === 'warn' || issue.severity === 'fail')) return 'warn'
  return 'ok'
}

/**
 * 一次完整评估：日容量 + 目标级容量 + 分档 + 给用户的选项。
 *
 * 纯函数，不读库；propose 只负责把数据搬进来。
 * @param input - 逐项、规则、目标、已排工时、今天。
 */
export function evaluatePlan(input: {
  entries: readonly PlanEntry[]
  rules: CapacityRules
  goal: { deadline: string | null }
  existingMinutes: number
  today: string
}): PlanEvaluation {
  const report = checkCapacity(input.entries, input.rules)
  const proposedMinutes = input.entries.reduce((sum, entry) => sum + entry.estMinutes, 0)
  const goalIssue = checkGoalCapacity({
    proposedMinutes,
    existingMinutes: input.existingMinutes,
    deadline: input.goal.deadline,
    today: input.today,
    rules: input.rules,
  })
  const issues = goalIssue === undefined ? report.issues : [...report.issues, goalIssue]
  const verdict = verdictOf(issues)
  const options: DecisionOption[] = verdict !== 'needs_decision'
    ? []
    : [
      { code: 'accept_overload', label: '接受超载/超期，直接提交' },
      { code: 'apply_reschedule', label: '把低优先级任务挪到有余量的日期' },
      { code: 'shrink', label: '砍掉次要任务或压缩工时' },
    ]
  return { verdict, issues, days: report.days, unplanned: report.unplanned, options }
}

/**
 * 校验一组计划的日容量与粒度。
 *
 * 判定：任一日 `load > 1` 为 fail；`0.85 <= load <= 1` 为 warn；任务超过 120 分钟为 warn；
 * 未排期任务只给 info。`verdict` 取最严重的一档。
 *
 * @param entries - 待校验项（提案或库内任务均可映射成它）。
 * @param rules - 容量规则。
 * @returns 报告：verdict、issues、逐日负载、未排期数。
 */
export function checkCapacity(entries: readonly PlanEntry[], rules: CapacityRules): CapacityReport {
  const issues: Issue[] = []
  const totals = new Map<string, number>()
  let unplanned = 0

  for (const entry of entries) {
    if (entry.estMinutes > MAX_TASK_MINUTES) {
      issues.push({
        kind: 'task-too-big',
        severity: 'warn',
        blocking: 'none',
        message: `「${entry.title}」预计 ${entry.estMinutes} 分钟，超过 ${MAX_TASK_MINUTES} 分钟，建议再拆一次`,
        suggestion: '按交付物或里程碑切开，每段控制在 25–120 分钟',
      })
    }
    const day = entry.day ?? null
    if (day === null) {
      unplanned += 1
      continue
    }
    totals.set(day, (totals.get(day) ?? 0) + entry.estMinutes)
  }

  const days: DayLoad[] = [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, planned]) => {
      const limit = limitFor(day, rules)
      return { day, planned, limit, load: planned / limit }
    })

  for (const item of days) {
    if (item.load > 1) {
      // 超一倍或超过物理上限：数据有问题，直接拒绝；否则交给用户决定。
      const absurd = item.planned > item.limit * 2 || item.planned > MAX_DAY_MINUTES
      issues.push({
        kind: 'overload',
        severity: 'fail',
        blocking: absurd ? 'invalid' : 'decision',
        message: `${item.day} 已排 ${item.planned}/${item.limit} 分钟，超出 ${item.planned - item.limit} 分钟`,
        day: item.day,
        suggestion: '把低优先级任务挪到空余日期，或把任务拆小后分散',
      })
    } else if (item.load >= WARN_RATIO) {
      issues.push({
        kind: 'near-capacity',
        severity: 'warn',
        blocking: 'none',
        message: `${item.day} 已排 ${item.planned}/${item.limit} 分钟，接近上限`,
        day: item.day,
        suggestion: '每天留约 20% 缓冲，别把一天排满',
      })
    }
  }

  if (unplanned > 0) {
    issues.push({
      kind: 'unplanned',
      severity: 'info',
      blocking: 'none',
      message: `有 ${unplanned} 个任务未排期（day 为空）`,
      suggestion: '确认它们是刻意搁置的杂事，而不是漏排',
    })
  }

  return { verdict: verdictOf(issues), issues, days, unplanned }
}
