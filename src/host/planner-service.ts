import type {
  CapacityRules,
  DayLoad,
  DraftMode,
  Goal,
  Issue,
  Priority,
  Task,
  Verdict,
} from '../core/types.js'
import {
  addDays,
  capacityBetween,
  checkCapacity,
  evaluatePlan,
  limitFor,
  monthGrid,
  todayInShanghai,
  type CapacityReport,
  type PlanEntry,
  type PlanVerdict,
} from '../core/validation/capacity.js'
import { runJudge, type JudgeChat, type JudgeVerdict } from '../judge.js'
import { runReschedule, type Move, type RescheduleChat } from '../reschedule.js'
import type {
  CreateGoalInput,
  GoalPatch,
  PlannerRepository,
  TaskFilter,
  TaskPatch,
} from './repository.js'

export interface PlannerServiceOptions {
  judgeChat?: JudgeChat
  judgeModel?: string
  judgeTimeoutMs?: number
  judgeMaxIssues?: number
  rescheduleChat?: RescheduleChat
  rescheduleTimeoutMs?: number
}

export interface LegacyDraftTask {
  title: string
  day?: string
  estMinutes: number
  priority?: Priority
  note?: string
}

export interface LegacyDraftPayload {
  phases: Array<{ title: string; startDay?: string; endDay?: string; tasks: LegacyDraftTask[] }>
  looseTasks: LegacyDraftTask[]
}

export interface CalendarMonthView {
  month: string
  today: string
  days: Array<{ day: string; planned: number; limit: number; count: number; inMonth: boolean }>
  goals: Array<{
    id: string
    title: string
    deadline: string | null
    done: number
    total: number
    percent: number
    atRisk: boolean
  }>
  capacity: CapacityRules
  unscheduled: Task[]
}

export interface CalendarDayView {
  day: string
  planned: number
  limit: number
  tasks: Task[]
}

export interface OverviewView {
  goals: Array<{ goal: Goal; done: number; total: number; percent: number }>
  days: DayLoad[]
  risks: Array<{ goalId: string; title: string; remaining: number; usable: number }>
}

const JUDGE_TO_PLAN: Record<JudgeVerdict, PlanVerdict> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'needs_decision',
  unverified: 'warn',
}

const PLAN_ORDER: readonly PlanVerdict[] = ['ok', 'warn', 'needs_decision', 'invalid']

function worseVerdict(left: PlanVerdict, right: PlanVerdict): PlanVerdict {
  return PLAN_ORDER.indexOf(left) >= PLAN_ORDER.indexOf(right) ? left : right
}

function storedVerdict(verdict: PlanVerdict): Verdict {
  if (verdict === 'invalid') return 'fail'
  if (verdict === 'ok') return 'pass'
  return 'warn'
}

function flattenPayload(payload: LegacyDraftPayload): LegacyDraftTask[] {
  const flat: LegacyDraftTask[] = []
  for (const phase of payload.phases) flat.push(...phase.tasks)
  flat.push(...payload.looseTasks)
  return flat
}

function applyMovesToPayload(payload: LegacyDraftPayload, moves: readonly Move[]): LegacyDraftPayload {
  const byIndex = new Map(moves.map((move) => [move.index, move.to]))
  let index = 0
  const take = (task: LegacyDraftTask): LegacyDraftTask => {
    const to = byIndex.get(index)
    index += 1
    return to === undefined ? task : { ...task, day: to }
  }
  return {
    phases: payload.phases.map((phase) => ({ ...phase, tasks: phase.tasks.map(take) })),
    looseTasks: payload.looseTasks.map(take),
  }
}

function payloadEntries(payload: LegacyDraftPayload): PlanEntry[] {
  const entries: PlanEntry[] = []
  for (const phase of payload.phases) {
    for (const task of phase.tasks) entries.push({ title: task.title, day: task.day ?? null, estMinutes: task.estMinutes })
  }
  for (const task of payload.looseTasks) entries.push({ title: task.title, day: task.day ?? null, estMinutes: task.estMinutes })
  return entries
}

function formatDay(load: DayLoad): string {
  const overflow = load.planned > load.limit ? `（超 ${load.planned - load.limit}）` : ''
  return `${load.day} ${load.planned}/${load.limit}${overflow}`
}

function formatIssues(issues: ReadonlyArray<{ severity: string; message: string; suggestion?: string }>): string {
  if (issues.length === 0) return '问题：无'
  const lines = issues.map((issue, index) => {
    const hint = issue.suggestion === undefined ? '' : ` → ${issue.suggestion}`
    return `${index + 1}. [${issue.severity}] ${issue.message}${hint}`
  })
  return `问题：\n${lines.join('\n')}`
}

function bad(message: string): string {
  return `错误：${message}`
}

/** 所有 legacy 用例的业务入口；Adapter 只负责参数和响应协议。 */
export class PlannerService {
  private readonly repo: PlannerRepository
  private readonly options: PlannerServiceOptions

  constructor(repo: PlannerRepository, options: PlannerServiceOptions = {}) {
    this.repo = repo
    this.options = options
  }

  createGoal(input: CreateGoalInput): Goal { return this.repo.createGoal(input) }
  getGoal(id: string): Goal | undefined { return this.repo.getGoal(id) }
  updateGoal(id: string, patch: GoalPatch): Goal | undefined { return this.repo.updateGoal(id, patch) }

  queryTasks(filter: TaskFilter = {}): Task[] { return this.repo.listTasks(filter) }

  queryCalendarMonth(month: string): CalendarMonthView {
    const grid = monthGrid(month)
    const capacity = this.repo.getCapacity()
    const from = grid[0]!
    const to = grid[grid.length - 1]!
    const tasks = this.repo.listTasks({ from, to, limit: 200 })
    const byDay = new Map<string, { planned: number; count: number }>()
    for (const task of tasks) {
      if (task.day === null) continue
      const entry = byDay.get(task.day) ?? { planned: 0, count: 0 }
      entry.count += 1
      if (task.status !== 'done' && task.status !== 'dropped') entry.planned += task.estMinutes
      byDay.set(task.day, entry)
    }
    const days = grid.map((day) => {
      const entry = byDay.get(day)
      return {
        day,
        planned: entry?.planned ?? 0,
        limit: limitFor(day, capacity),
        count: entry?.count ?? 0,
        inMonth: day.slice(0, 7) === month,
      }
    })
    const today = todayInShanghai()
    const goals = this.repo.listGoals('active').map((goal) => {
      const mine = this.repo.listTasks({ goalId: goal.id, limit: 200 })
      const done = mine.filter((task) => task.status === 'done').length
      const total = mine.length
      const remaining = mine
        .filter((task) => task.status !== 'done' && task.status !== 'dropped')
        .reduce((sum, task) => sum + task.estMinutes, 0)
      const usable = goal.deadline === null || goal.deadline < today ? 0 : capacityBetween(today, goal.deadline, capacity)
      return {
        id: goal.id,
        title: goal.title,
        deadline: goal.deadline,
        done,
        total,
        percent: total === 0 ? 0 : Math.round((done / total) * 100),
        atRisk: goal.deadline !== null && remaining > usable,
      }
    })
    const unscheduled = this.repo.listTasks({ limit: 200 })
      .filter((task) => task.day === null && task.status !== 'done' && task.status !== 'dropped')
    return { month, today, days, goals, capacity, unscheduled }
  }

  queryCalendarDay(day: string): CalendarDayView {
    const capacity = this.repo.getCapacity()
    const tasks = this.repo.listTasks({ from: day, to: day, limit: 200 })
    const planned = tasks
      .filter((task) => task.status !== 'done' && task.status !== 'dropped')
      .reduce((sum, task) => sum + task.estMinutes, 0)
    return { day, planned, limit: limitFor(day, capacity), tasks }
  }

  private reportFor(days: string[]): CapacityReport | undefined {
    const sorted = [...new Set(days)].sort()
    if (sorted.length === 0) return undefined
    const tasks = this.repo.listTasks({ from: sorted[0]!, to: sorted[sorted.length - 1]!, limit: 200 })
      .filter((task) => task.day !== null && sorted.includes(task.day))
    return checkCapacity(
      tasks.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
      this.repo.getCapacity(),
    )
  }

  updateTasks(patches: TaskPatch[]): { tasks: Task[]; report?: CapacityReport } {
    const tasks = this.repo.updateTasks(patches)
    const report = this.reportFor(tasks.map((task) => task.day).filter((day): day is string => day !== null))
    return { tasks, ...(report === undefined ? {} : { report }) }
  }

  updateCapacity(rules: CapacityRules): { capacity: CapacityRules; report: CapacityReport } {
    this.repo.setCapacity(rules)
    const today = todayInShanghai()
    const grid = monthGrid(today.slice(0, 7))
    const tasks = this.repo.listTasks({ from: grid[0]!, to: grid[grid.length - 1]!, limit: 200 })
    const capacity = this.repo.getCapacity()
    const report = checkCapacity(
      tasks.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
      capacity,
    )
    return { capacity, report }
  }

  queryOverview(from: string, to: string, goalId?: string): OverviewView {
    const goals = this.repo.listGoals('active').filter((goal) => goalId === undefined || goal.id === goalId)
    const allTasks = this.repo.listTasks({ from, to, limit: 200, ...(goalId === undefined ? {} : { goalId }) })
    const summaries = goals.map((goal) => {
      const mine = allTasks.filter((task) => task.goalId === goal.id)
      const done = mine.filter((task) => task.status === 'done').length
      const total = mine.length
      return { goal, done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
    })
    const capacity = this.repo.getCapacity()
    const report = checkCapacity(
      allTasks.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
      capacity,
    )
    const today = todayInShanghai()
    const risks = goals.flatMap((goal) => {
      if (goal.deadline === null || goal.deadline < today) return []
      const remaining = this.repo.listTasks({ goalId: goal.id, limit: 200 })
        .filter((task) => task.status !== 'done' && task.status !== 'dropped')
        .reduce((sum, task) => sum + task.estMinutes, 0)
      const usable = capacityBetween(today, goal.deadline, capacity)
      return remaining <= usable ? [] : [{ goalId: goal.id, title: goal.title, remaining, usable }]
    })
    return { goals: summaries, days: report.days, risks }
  }

  async legacyPropose(command: {
    goalId: string
    payload: LegacyDraftPayload
    mode: DraftMode
    draftId?: string
  }): Promise<string> {
    const goal = this.repo.getGoal(command.goalId)
    if (goal === undefined) return bad(`目标 ${command.goalId} 不存在`)
    const existing = command.draftId === undefined ? undefined : this.repo.getDraft(command.draftId)
    if (command.draftId !== undefined && existing === undefined) return bad(`草稿 ${command.draftId} 不存在`)
    if (existing !== undefined && existing.status !== 'open') return bad(`草稿 ${command.draftId} 状态为 ${existing.status}，不能再改`)
    const draft = existing === undefined
      ? this.repo.createDraft({ goalId: command.goalId, mode: command.mode, payload: command.payload })
      : this.repo.updateDraftPayload(existing.id, command.payload)
    const entries = payloadEntries(command.payload)
    const existingMinutes = this.repo.listTasks({ goalId: command.goalId, limit: 200 })
      .filter((task) => task.status !== 'done' && task.status !== 'dropped')
      .reduce((sum, task) => sum + task.estMinutes, 0)
    const evaluation = evaluatePlan({
      entries,
      rules: this.repo.getCapacity(),
      goal: { deadline: goal.deadline },
      existingMinutes,
      today: todayInShanghai(),
    })
    if (evaluation.verdict === 'invalid') {
      this.repo.setDraftStatus(draft.id, 'discarded')
      this.repo.appendCheck({ kind: 'capacity', target: draft.id, verdict: 'fail', issues: evaluation.issues })
      return bad(`提案有结构性错误，不能提交：\n${formatIssues(evaluation.issues)}`)
    }
    let judgeIssues: Issue[] = []
    let judgeNote = ''
    let verdict: PlanVerdict = evaluation.verdict
    if (this.options.judgeChat !== undefined) {
      const result = await runJudge(this.options.judgeChat, {
        goal: { title: goal.title, motivation: goal.motivation, deadline: goal.deadline },
        tasks: entries.map((entry) => ({
          title: entry.title,
          day: entry.day ?? undefined,
          estMinutes: entry.estMinutes,
        })),
        capacity: {
          days: evaluation.days.map((day) => ({ day: day.day, planned: day.planned, limit: day.limit })),
          issues: evaluation.issues,
        },
      }, {
        ...(this.options.judgeTimeoutMs === undefined ? {} : { timeoutMs: this.options.judgeTimeoutMs }),
        ...(this.options.judgeMaxIssues === undefined ? {} : { maxIssues: this.options.judgeMaxIssues }),
      })
      judgeIssues = result.issues
      verdict = worseVerdict(verdict, JUDGE_TO_PLAN[result.verdict])
      this.repo.appendCheck({
        kind: 'semantic',
        target: draft.id,
        verdict: result.verdict,
        issues: result.issues,
        ...(this.options.judgeModel === undefined ? {} : { model: this.options.judgeModel }),
      })
      if (result.note !== undefined) {
        const excerpt = result.raw.trim().slice(0, 200)
        judgeNote = excerpt === ''
          ? `\n语义评审：${result.note}（按未验证处理）· 模型输出为空`
          : `\n语义评审：${result.note}（按未验证处理）· 原始输出：${excerpt}`
      }
    }
    this.repo.setDraftVerdict(draft.id, storedVerdict(verdict))
    this.repo.appendCheck({ kind: 'capacity', target: draft.id, verdict: storedVerdict(evaluation.verdict), issues: evaluation.issues })
    this.repo.setDraftDecision(draft.id, verdict === 'needs_decision', verdict === 'needs_decision' ? evaluation.options : undefined)
    const loads = evaluation.days.length === 0 ? '容量：没有已排期的任务' : `容量：${evaluation.days.map(formatDay).join('；')}`
    const unplanned = evaluation.unplanned === 0 ? '' : `\n未排期：${evaluation.unplanned} 个任务没有 day`
    const optionLines = verdict !== 'needs_decision'
      ? ''
      : `\n需要用户决定（把选项原样交给用户，不要自己选）：\n${evaluation.options
        .map((option, index) => `  ${index + 1}. ${option.label}（decision="${option.code}"）`)
        .join('\n')}`
    const action = verdict === 'needs_decision'
      ? '下一步：先把上面每个问题的影响讲清楚，再让用户选一个选项；用户选好后调 planner_plan_commit(draft_id, decision, reason)。'
      : `下一步：让用户确认后调用 planner_plan_commit(draft_id="${draft.id}")；要改就带同样的 draft_id 重新 propose。`
    return `提案已生成 ${draft.id}，结论 ${verdict}。\n${loads}${unplanned}\n${formatIssues([...evaluation.issues, ...judgeIssues])}${judgeNote}${optionLines}\n${action}`
  }

  async legacyCommit(command: { draftId: string; decision?: string; reason?: string }): Promise<string> {
    const draft = this.repo.getDraft(command.draftId)
    if (draft === undefined) return bad(`草稿 ${command.draftId} 不存在`)
    if (draft.status !== 'open') return bad(`草稿 ${command.draftId} 已经 ${draft.status}，不能重复提交`)
    if (new Date(draft.expiresAt).getTime() < Date.now()) return bad(`草稿已过期（生成于 ${draft.createdAt}），请重新 propose`)
    let payload: LegacyDraftPayload
    try {
      payload = JSON.parse(draft.payloadJson) as LegacyDraftPayload
    } catch {
      return bad('草稿内容已损坏，请重新 propose')
    }
    const goal = draft.goalId === null ? undefined : this.repo.getGoal(draft.goalId)
    const entries = payloadEntries(payload)
    const existingMinutes = draft.goalId === null
      ? 0
      : this.repo.listTasks({ goalId: draft.goalId, limit: 200 })
        .filter((task) => task.status !== 'done' && task.status !== 'dropped')
        .reduce((sum, task) => sum + task.estMinutes, 0)
    const evaluation = evaluatePlan({
      entries,
      rules: this.repo.getCapacity(),
      goal: { deadline: goal?.deadline ?? null },
      existingMinutes,
      today: todayInShanghai(),
    })
    if (evaluation.verdict === 'invalid') return bad(`草稿有结构性错误，不能提交：\n${formatIssues(evaluation.issues)}`)
    const decision = command.decision === 'accept_overload' || command.decision === 'apply_reschedule' || command.decision === 'shrink'
      ? command.decision
      : undefined
    if (evaluation.verdict === 'needs_decision' && decision === undefined) {
      const options = evaluation.options
        .map((option, index) => `  ${index + 1}. ${option.label}（decision="${option.code}"）`)
        .join('\n')
      return bad(`这份草稿需要用户决定：\n${formatIssues(evaluation.issues)}\n可选：\n${options}\n用户选好后带 decision（可附 reason）再提交。`)
    }
    let commitPayload = payload
    let moveReport = ''
    if (decision === 'apply_reschedule') {
      if (this.options.rescheduleChat === undefined) {
        return bad('没有配置模型，无法按语义自动挪动。请改用 decision="shrink" 或 "accept_overload"，或手动改好日期后重新 propose。')
      }
      const today = todayInShanghai()
      const flat = flattenPayload(payload)
      const capacity = this.repo.getCapacity()
      const lastDay = flat.reduce((max, task) => (task.day !== undefined && task.day > max ? task.day : max), today)
      const end = goal?.deadline !== null && goal?.deadline !== undefined && goal.deadline < lastDay ? lastDay : (goal?.deadline ?? lastDay)
      const existing = this.repo.listTasks({ from: today, to: end, limit: 200 })
      const planned = new Map<string, number>()
      for (const task of existing) {
        if (task.day === null || task.status === 'done' || task.status === 'dropped') continue
        planned.set(task.day, (planned.get(task.day) ?? 0) + task.estMinutes)
      }
      for (const task of flat) {
        if (task.day === undefined) continue
        planned.set(task.day, (planned.get(task.day) ?? 0) + task.estMinutes)
      }
      const days: Array<{ day: string; limit: number; planned: number }> = []
      for (let day = today; day <= end; day = addDays(day, 1)) {
        days.push({ day, limit: limitFor(day, capacity), planned: planned.get(day) ?? 0 })
      }
      const proposal = await runReschedule(this.options.rescheduleChat, {
        entries: flat.map((task, index) => ({
          index,
          title: task.title,
          day: task.day ?? null,
          estMinutes: task.estMinutes,
          priority: task.priority ?? 'P2',
        })),
        days,
        today,
        deadline: goal?.deadline ?? null,
      }, {
        ...(this.options.rescheduleTimeoutMs === undefined ? {} : { timeoutMs: this.options.rescheduleTimeoutMs }),
      })
      if (proposal.note !== undefined) return bad(`自动挪动失败：${proposal.note}`)
      if (proposal.issues.length > 0) {
        return bad(`模型给的挪动方案不合法，未提交：\n${formatIssues(proposal.issues)}\n可以让用户改用 shrink / accept_overload，或改好日期重新 propose。`)
      }
      if (proposal.moves.length === 0) return bad('模型没有给出任何可挪动的任务；若确实挪不动，请改用 decision="shrink" 或 "accept_overload"。')
      commitPayload = applyMovesToPayload(payload, proposal.moves)
      moveReport = proposal.moves
        .map((move) => `「${flat[move.index]?.title ?? `#${move.index}`}」→ ${move.to}${move.reason === undefined ? '' : `（${move.reason}）`}`)
        .join('；')
    }
    if (decision !== undefined) {
      const reasonText = command.reason?.trim() ?? ''
      this.repo.appendCheck({
        kind: 'override',
        target: draft.id,
        verdict: 'warn',
        issues: evaluation.issues,
        model: `user:${decision}${reasonText === '' ? '' : ` · ${reasonText}`}${moveReport === '' ? '' : ` · ${moveReport}`}`,
      })
    }
    const result = this.repo.transaction(() => {
      let taskCount = 0
      let unplanned = 0
      for (const [index, phase] of commitPayload.phases.entries()) {
        const created = this.repo.createPhase({
          goalId: draft.goalId ?? '',
          title: phase.title,
          seq: index + 1,
          ...(phase.startDay === undefined ? {} : { startDay: phase.startDay }),
          ...(phase.endDay === undefined ? {} : { endDay: phase.endDay }),
        })
        for (const task of phase.tasks) {
          this.repo.createTask({
            ...(draft.goalId === null ? {} : { goalId: draft.goalId }),
            phaseId: created.id,
            title: task.title,
            ...(task.day === undefined ? {} : { day: task.day }),
            estMinutes: task.estMinutes,
            ...(task.priority === undefined ? {} : { priority: task.priority }),
            ...(task.note === undefined ? {} : { note: task.note }),
          })
          taskCount += 1
          if (task.day === undefined) unplanned += 1
        }
      }
      for (const task of commitPayload.looseTasks) {
        this.repo.createTask({
          ...(draft.goalId === null ? {} : { goalId: draft.goalId }),
          title: task.title,
          ...(task.day === undefined ? {} : { day: task.day }),
          estMinutes: task.estMinutes,
          ...(task.priority === undefined ? {} : { priority: task.priority }),
          ...(task.note === undefined ? {} : { note: task.note }),
        })
        taskCount += 1
        if (task.day === undefined) unplanned += 1
      }
      this.repo.setDraftStatus(draft.id, 'committed')
      this.repo.appendCheck({ kind: 'commit', target: draft.id, verdict: storedVerdict(evaluation.verdict), issues: [] })
      return { phases: commitPayload.phases.length, tasks: taskCount, unplanned }
    })
    const extra = result.unplanned === 0 ? '' : `，其中 ${result.unplanned} 个未排期`
    const moved = moveReport === '' ? '' : `\n挪动：${moveReport}`
    return `已落库：${result.phases} 个阶段、${result.tasks} 个任务${extra}。${moved}`
  }
}
