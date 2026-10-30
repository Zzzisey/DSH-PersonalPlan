/**
 * Agent 工具：六个 defineTool。
 *
 * 三条统一约定（DESIGN §6）：返回自然语言字符串；可预期失败返回 `错误：…` 而不是抛异常；
 * 写操作整批事务。
 * @module @local/planner/tools
 */
import type { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  appendCheck,
  createDraft,
  createGoal,
  createPhase,
  createTask,
  getCapacity,
  getDraft,
  getGoal,
  listGoals,
  listTasks,
  setDraftStatus,
  setDraftVerdict,
  transaction,
  updateDraftPayload,
  updateTasks,
} from './db/repo.js'
import { mergeVerdict, runJudge, type JudgeChat } from './judge.js'
import { addDays, capacityBetween, checkCapacity, todayInShanghai, type PlanEntry } from './planning.js'
import type { CapacityRules, DayLoad, DraftMode, Issue, Priority, Task, TaskStatus, Verdict } from './types.js'

/** 工具层的可选依赖：目前只有语义评审。缺省时只跑容量校验。 */
export interface PlannerToolOptions {
  judgeChat?: JudgeChat
  judgeModel?: string
  judgeTimeoutMs?: number
  judgeMaxIssues?: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2']
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'dropped']

/** 草稿里的一条任务；commit 时按它建 task。 */
interface DraftTask {
  title: string
  day?: string
  estMinutes: number
  priority?: Priority
  note?: string
}

/** 草稿 payload：propose 写、commit 读。 */
interface DraftPayload {
  phases: Array<{ title: string; startDay?: string; endDay?: string; tasks: DraftTask[] }>
  looseTasks: DraftTask[]
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function bad(message: string): string {
  return `错误：${message}`
}

/** 校验并归一化日期；返回 undefined 表示非法（调用方据此报错）。 */
function parseDate(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null
  return value
}

function formatDay(load: DayLoad): string {
  const overflow = load.planned > load.limit ? `（超 ${load.planned - load.limit}）` : ''
  return `${load.day} ${load.planned}/${load.limit}${overflow}`
}

function formatTask(task: Task): string {
  const parts = [`- ${task.id} [${task.priority}/${task.status}] ${task.title}`]
  parts.push(task.day === null ? '未排期' : task.day)
  parts.push(`${task.estMinutes}min`)
  return parts.join(' · ')
}

function formatIssues(issues: ReadonlyArray<{ severity: string; message: string; suggestion?: string }>): string {
  if (issues.length === 0) return '问题：无'
  const lines = issues.map((issue, index) => {
    const hint = issue.suggestion === undefined ? '' : ` → ${issue.suggestion}`
    return `${index + 1}. [${issue.severity}] ${issue.message}${hint}`
  })
  return `问题：\n${lines.join('\n')}`
}

/** 把 propose 入参解析成 payload；出错时返回可读字符串。 */
function parsePayload(phasesRaw: unknown, looseRaw: unknown): DraftPayload | string {
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) return 'phases 必须是非空数组'
  const phases: DraftPayload['phases'] = []
  for (const [phaseIndex, rawPhase] of phasesRaw.entries()) {
    const phase = (typeof rawPhase === 'object' && rawPhase !== null ? rawPhase : {}) as Record<string, unknown>
    const title = str(phase.title)
    if (title === undefined) return `phases[${phaseIndex}].title 必填`
    const startDay = parseDate(phase.start_day ?? phase.startDay)
    const endDay = parseDate(phase.end_day ?? phase.endDay)
    if (startDay === null || endDay === null) return `phases[${phaseIndex}] 的日期必须是 YYYY-MM-DD`
    const tasksRaw = phase.tasks
    if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return `phases[${phaseIndex}].tasks 必须是非空数组`
    const tasks: DraftTask[] = []
    for (const [taskIndex, rawTask] of tasksRaw.entries()) {
      const parsed = parseDraftTask(rawTask, `phases[${phaseIndex}].tasks[${taskIndex}]`)
      if (typeof parsed === 'string') return parsed
      tasks.push(parsed)
    }
    phases.push({
      title,
      ...(startDay === undefined ? {} : { startDay }),
      ...(endDay === undefined ? {} : { endDay }),
      tasks,
    })
  }
  const looseTasks: DraftTask[] = []
  if (looseRaw !== undefined) {
    if (!Array.isArray(looseRaw)) return 'loose_tasks 必须是数组'
    for (const [index, rawTask] of looseRaw.entries()) {
      const parsed = parseDraftTask(rawTask, `loose_tasks[${index}]`)
      if (typeof parsed === 'string') return parsed
      looseTasks.push(parsed)
    }
  }
  return { phases, looseTasks }
}

function parseDraftTask(raw: unknown, at: string): DraftTask | string {
  const task = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const title = str(task.title)
  if (title === undefined) return `${at}.title 必填`
  const day = parseDate(task.day)
  if (day === null) return `${at}.day 必须是 YYYY-MM-DD`
  const minutesRaw = task.est_minutes ?? task.estMinutes
  const estMinutes = typeof minutesRaw === 'number' && Number.isInteger(minutesRaw) && minutesRaw > 0 ? minutesRaw : 30
  const priorityRaw = str(task.priority) as Priority | undefined
  const priority = priorityRaw !== undefined && PRIORITIES.includes(priorityRaw) ? priorityRaw : undefined
  const note = str(task.note)
  return {
    title,
    ...(day === undefined ? {} : { day }),
    estMinutes,
    ...(priority === undefined ? {} : { priority }),
    ...(note === undefined ? {} : { note }),
  }
}

function payloadEntries(payload: DraftPayload): PlanEntry[] {
  const entries: PlanEntry[] = []
  for (const phase of payload.phases) {
    for (const task of phase.tasks) entries.push({ title: task.title, day: task.day ?? null, estMinutes: task.estMinutes })
  }
  for (const task of payload.looseTasks) entries.push({ title: task.title, day: task.day ?? null, estMinutes: task.estMinutes })
  return entries
}

/**
 * 构造六个工具。
 * @param db - 已打开的连接；工具不自己开库。
 * @returns 可直接交给 `ctx.tools.register` 的定义数组。
 */
export function createPlannerTools(db: DatabaseSync, options: PlannerToolOptions = {}) {
  const goalCreate = defineTool({
    name: 'planner_goal_create',
    description:
      '创建一个长期目标（求职、转岗、作品集等）。目标下再挂阶段与任务。只在用户明确要开始一个新目标时调用；'
      + '创建后把 goal_id 记下来，后续 propose 要用。不要用它记录单个待办。',
    parameters: {
      title: { type: 'string', required: true, description: '目标标题，简短可识别，例如「两周内拿到 3 个面试」' },
      motivation: { type: 'string', description: '为什么要做；语义评审会用它判断计划是否覆盖目标' },
      deadline: { type: 'string', description: '截止日期 YYYY-MM-DD，可空' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const title = str(args.title)
      if (title === undefined) return bad('title 必填')
      const deadline = parseDate(args.deadline)
      if (deadline === null) return bad('deadline 必须是 YYYY-MM-DD')
      const motivation = str(args.motivation)
      const goal = createGoal(db, {
        title,
        ...(motivation === undefined ? {} : { motivation }),
        ...(deadline === undefined ? {} : { deadline }),
      })
      const tail = goal.deadline === null ? '' : `（截止 ${goal.deadline}）`
      return `已创建目标「${goal.title}」${goal.id}${tail}。下一步：用 planner_plan_propose 提交计划。`
    },
  })

  const planPropose = defineTool({
    name: 'planner_plan_propose',
    description:
      '提交（或修订）一份计划提案，写入草稿并做容量校验，**不改正式任务**。phases 是阶段数组，每个阶段带 tasks；'
      + '不属于任何阶段的任务放 loose_tasks。带 draft_id 表示在上一份提案上改。'
      + '返回 verdict 与问题清单：fail 必须改，warn 可以改也可以确认后强制提交。'
      + '不要声称任务已创建——落库要用户在界面上确认后调用 planner_plan_commit。',
    parameters: {
      goal_id: { type: 'string', required: true, description: '来自 planner_goal_create 的目标 id' },
      phases: {
        type: 'json',
        required: true,
        description: '阶段数组：[{ title, start_day?, end_day?, tasks: [{ title, day?, est_minutes, priority?, note? }] }]',
      },
      loose_tasks: { type: 'json', description: '不属于任何阶段的任务数组，字段同上' },
      draft_id: { type: 'string', description: '已有草稿 id；修订同一份提案时传' },
      mode: { type: 'string', enum: ['new', 'adjust'], description: 'new=新计划，adjust=调整既有计划' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const goalId = str(args.goal_id)
      if (goalId === undefined) return bad('goal_id 必填')
      const goal = getGoal(db, goalId)
      if (goal === undefined) return bad(`目标 ${goalId} 不存在`)

      const payload = parsePayload(args.phases, args.loose_tasks)
      if (typeof payload === 'string') return bad(payload)

      const modeRaw = str(args.mode)
      const mode: DraftMode = modeRaw === 'adjust' ? 'adjust' : 'new'
      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? undefined : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return bad(`草稿 ${draftId} 不存在`)
      if (existing !== undefined && existing.status !== 'open') return bad(`草稿 ${draftId} 状态为 ${existing.status}，不能再改`)

      const draft = existing === undefined
        ? createDraft(db, { goalId, mode, payload })
        : updateDraftPayload(db, existing.id, payload)

      const capacity = getCapacity(db) as CapacityRules
      const report = checkCapacity(payloadEntries(payload), capacity)
      appendCheck(db, { kind: 'capacity', target: draft.id, verdict: report.verdict, issues: report.issues })

      // 语义评审是可选增强：没配置模型就只跑容量，绝不因此拖慢或阻断 propose。
      let judgeIssues: Issue[] = []
      let judgeNote = ''
      let verdict: Verdict = report.verdict
      if (options.judgeChat !== undefined) {
        const result = await runJudge(options.judgeChat, {
          goal: { title: goal.title, motivation: goal.motivation, deadline: goal.deadline },
          tasks: payloadEntries(payload).map((entry) => ({
            title: entry.title,
            day: entry.day ?? undefined,
            estMinutes: entry.estMinutes,
          })),
          capacity: {
            days: report.days.map((day) => ({ day: day.day, planned: day.planned, limit: day.limit })),
            issues: report.issues,
          },
        }, {
          ...(options.judgeTimeoutMs === undefined ? {} : { timeoutMs: options.judgeTimeoutMs }),
          ...(options.judgeMaxIssues === undefined ? {} : { maxIssues: options.judgeMaxIssues }),
        })
        judgeIssues = result.issues
        verdict = mergeVerdict(report.verdict, result.verdict)
        appendCheck(db, {
          kind: 'semantic',
          target: draft.id,
          verdict: result.verdict,
          issues: result.issues,
          ...(options.judgeModel === undefined ? {} : { model: options.judgeModel }),
        })
        if (result.note !== undefined) judgeNote = `\n语义评审：${result.note}（按未验证处理）`
      }
      setDraftVerdict(db, draft.id, verdict)

      const loads = report.days.length === 0 ? '容量：没有已排期的任务' : `容量：${report.days.map(formatDay).join('；')}`
      const unplanned = report.unplanned === 0 ? '' : `\n未排期：${report.unplanned} 个任务没有 day`
      const action = verdict === 'fail'
        ? '下一步：按上面的问题改这份提案（带同一个 draft_id 再调本工具），fail 不能提交。'
        : '下一步：让用户确认后调用 planner_plan_commit(draft_id="' + draft.id + '")；要改就带同样的 draft_id 重新 propose。'
      return `提案已生成 ${draft.id}，结论 ${verdict}。\n${loads}${unplanned}\n${formatIssues([...report.issues, ...judgeIssues])}${judgeNote}\n${action}`
    },
  })

  const planCommit = defineTool({
    name: 'planner_plan_commit',
    description:
      '把一份通过的草稿真正落库（阶段与任务）。只有用户明确确认后才调用。'
      + 'verdict=fail 的草稿拒绝提交；verdict=warn 需要 force=true，并且必须先把问题告诉用户。',
    parameters: {
      draft_id: { type: 'string', required: true, description: 'planner_plan_propose 返回的草稿 id' },
      force: { type: 'boolean', description: 'verdict=warn 时是否跳过确认（只在用户同意后置 true）' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const draftId = str(args.draft_id)
      if (draftId === undefined) return bad('draft_id 必填')
      const draft = getDraft(db, draftId)
      if (draft === undefined) return bad(`草稿 ${draftId} 不存在`)
      if (draft.status !== 'open') return bad(`草稿 ${draftId} 已经 ${draft.status}，不能重复提交`)
      if (new Date(draft.expiresAt).getTime() < Date.now()) return bad(`草稿已过期（生成于 ${draft.createdAt}），请重新 propose`)
      if (draft.verdict === 'fail') return bad('这份草稿有容量问题（verdict=fail），必须先改再提交')
      if (draft.verdict === 'warn' && args.force !== true) {
        return bad('这份草稿有警告（verdict=warn）。请先把问题告诉用户；用户同意后再带 force=true 提交')
      }

      let payload: DraftPayload
      try {
        payload = JSON.parse(draft.payloadJson) as DraftPayload
      } catch {
        return bad('草稿内容已损坏，请重新 propose')
      }

      const result = transaction(db, () => {
        let taskCount = 0
        let unplanned = 0
        for (const [index, phase] of payload.phases.entries()) {
          const created = createPhase(db, {
            goalId: draft.goalId ?? '',
            title: phase.title,
            seq: index + 1,
            ...(phase.startDay === undefined ? {} : { startDay: phase.startDay }),
            ...(phase.endDay === undefined ? {} : { endDay: phase.endDay }),
          })
          for (const task of phase.tasks) {
            createTask(db, {
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
        for (const task of payload.looseTasks) {
          createTask(db, {
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
        setDraftStatus(db, draft.id, 'committed')
        appendCheck(db, { kind: 'commit', target: draft.id, verdict: draft.verdict ?? 'pass', issues: [] })
        return { phases: payload.phases.length, tasks: taskCount, unplanned }
      })

      const extra = result.unplanned === 0 ? '' : `，其中 ${result.unplanned} 个未排期`
      return `已落库：${result.phases} 个阶段、${result.tasks} 个任务${extra}。`
    },
  })

  const taskQuery = defineTool({
    name: 'planner_task_query',
    description:
      '按日期区间查询已落库的任务。默认查今天起 7 天。只读，用来在改计划前确认现状；'
      + '不要用它猜计划，没查到就是没排。',
    parameters: {
      from: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
      to: { type: 'string', description: 'YYYY-MM-DD，默认 from 之后 7 天' },
      goal_id: { type: 'string', description: '只看某个目标的任务' },
      status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'], description: '按状态过滤' },
      limit: { type: 'number', description: '最多返回多少条，默认 50，上限 200' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const from = parseDate(args.from) ?? undefined
      if (from === null) return bad('from 必须是 YYYY-MM-DD')
      const to = parseDate(args.to) ?? undefined
      if (to === null) return bad('to 必须是 YYYY-MM-DD')
      const statusRaw = str(args.status)
      const status = statusRaw !== undefined && STATUSES.includes(statusRaw as TaskStatus) ? statusRaw as TaskStatus : undefined
      const start = from ?? todayInShanghai()
      const end = to ?? addDays(start, 7)
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(Math.max(Math.trunc(args.limit), 1), 200) : 50
      const goalId = str(args.goal_id)

      const tasks = listTasks(db, {
        from: start,
        to: end,
        ...(goalId === undefined ? {} : { goalId }),
        ...(status === undefined ? {} : { status }),
        limit,
      })
      if (tasks.length === 0) return `${start} ~ ${end} 没有任务。`
      const lines = tasks.map(formatTask).join('\n')
      const truncated = tasks.length >= limit ? `\n（已到 limit=${limit}，可能还有更多）` : ''
      return `${start} ~ ${end} 共 ${tasks.length} 个任务：\n${lines}${truncated}`
    },
  })

  const taskUpdate = defineTool({
    name: 'planner_task_update',
    description:
      '批量更新已落库的任务（改日期、状态、预估、优先级、备注）。**整批事务**：任何一条非法，整批都不生效。'
      + '单次最多 20 条。改完会在返回里给出受影响日期的负载，超载会明确提示（但不阻止——先让用户知道）。',
    parameters: {
      updates: {
        type: 'json',
        required: true,
        description: '数组：[{ id, day?, status?, est_minutes?, priority?, actual_minutes?, note? }]',
      },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      if (!Array.isArray(args.updates) || args.updates.length === 0) return bad('updates 必须是非空数组')
      if (args.updates.length > 20) return bad('一次最多更新 20 条')

      const patches: Parameters<typeof updateTasks>[1] = []
      for (const [index, raw] of args.updates.entries()) {
        const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
        const id = str(item.id)
        if (id === undefined) return bad(`updates[${index}].id 必填`)
        const day = parseDate(item.day)
        if (day === null) return bad(`updates[${index}].day 必须是 YYYY-MM-DD`)
        const statusRaw = str(item.status)
        if (statusRaw !== undefined && !STATUSES.includes(statusRaw as TaskStatus)) return bad(`updates[${index}].status 非法`)
        const priorityRaw = str(item.priority)
        if (priorityRaw !== undefined && !PRIORITIES.includes(priorityRaw as Priority)) return bad(`updates[${index}].priority 非法`)
        const minutesRaw = item.est_minutes ?? item.estMinutes
        if (minutesRaw !== undefined && (typeof minutesRaw !== 'number' || !Number.isInteger(minutesRaw) || minutesRaw <= 0)) {
          return bad(`updates[${index}].est_minutes 必须是正整数`)
        }
        const actualRaw = item.actual_minutes ?? item.actualMinutes
        if (actualRaw !== undefined && actualRaw !== null && (typeof actualRaw !== 'number' || actualRaw < 0)) {
          return bad(`updates[${index}].actual_minutes 必须是非负数`)
        }
        const note = item.note
        if (note !== undefined && note !== null && typeof note !== 'string') return bad(`updates[${index}].note 必须是字符串`)
        patches.push({
          id,
          ...(day === undefined ? {} : { day }),
          ...(statusRaw === undefined ? {} : { status: statusRaw as TaskStatus }),
          ...(priorityRaw === undefined ? {} : { priority: priorityRaw as Priority }),
          ...(minutesRaw === undefined ? {} : { estMinutes: minutesRaw as number }),
          ...(actualRaw === undefined ? {} : { actualMinutes: actualRaw as number | null }),
          ...(note === undefined ? {} : { note: note as string | null }),
        })
      }

      let updated: Task[]
      try {
        updated = updateTasks(db, patches)
      } catch (error) {
        return bad(error instanceof Error ? error.message : String(error))
      }

      const days = [...new Set(updated.map((task) => task.day).filter((day): day is string => day !== null))]
      const sorted = [...days].sort()
      if (sorted.length === 0) return `已更新 ${updated.length} 个任务。`
      const from = sorted[0]!
      const to = sorted[sorted.length - 1]!
      const affected = listTasks(db, { from, to, limit: 200 })
        .filter((task) => task.day !== null && days.includes(task.day))
      const report = checkCapacity(
        affected.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
        getCapacity(db) as CapacityRules,
      )
      const overloaded = report.days.filter((day) => day.planned > day.limit).map(formatDay)
      const note = overloaded.length === 0 ? '' : `\n注意：${overloaded.join('；')} 已超载，建议挪任务或拆小。`
      return `已更新 ${updated.length} 个任务。${note}`
    },
  })

  const overview = defineTool({
    name: 'planner_plan_overview',
    description:
      '概览：目标进度 + 日期负载 + 风险目标。用于汇报和判断"还来不来得及"，只读。',
    parameters: {
      from: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
      to: { type: 'string', description: 'YYYY-MM-DD，默认 from 之后 14 天' },
      goal_id: { type: 'string', description: '只看某个目标' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const from = parseDate(args.from) ?? undefined
      if (from === null) return bad('from 必须是 YYYY-MM-DD')
      const to = parseDate(args.to) ?? undefined
      if (to === null) return bad('to 必须是 YYYY-MM-DD')
      const goalId = str(args.goal_id)
      const start = from ?? todayInShanghai()
      const end = to ?? addDays(start, 14)

      const goals = listGoals(db, 'active').filter((goal) => goalId === undefined || goal.id === goalId)
      const allTasks = listTasks(db, { from: start, to: end, limit: 200, ...(goalId === undefined ? {} : { goalId }) })
      const goalLines = goals.map((goal) => {
        const mine = allTasks.filter((task) => task.goalId === goal.id)
        const done = mine.filter((task) => task.status === 'done').length
        const total = mine.length
        const percent = total === 0 ? 0 : Math.round((done / total) * 100)
        const deadline = goal.deadline === null ? '无截止' : `截止 ${goal.deadline}`
        return `- 「${goal.title}」${done}/${total}（${percent}%），${deadline}`
      })

      const capacity = getCapacity(db) as CapacityRules
      const report = checkCapacity(
        allTasks.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
        capacity,
      )
      const dayLines = report.days.map(formatDay)
      // 风险口径：该目标所有未完成任务的剩余工时，对比「今天到截止日」的**全部**容量。
      // 早先版本只累计了有任务日期的余量，又把已排任务算进 remaining，导致必然误报。
      const today = todayInShanghai()
      const risky = goals.flatMap((goal) => {
        if (goal.deadline === null || goal.deadline < today) return []
        const remaining = listTasks(db, { goalId: goal.id, limit: 200 })
          .filter((task) => task.status !== 'done' && task.status !== 'dropped')
          .reduce((sum, task) => sum + task.estMinutes, 0)
        const usable = capacityBetween(today, goal.deadline, capacity)
        if (remaining <= usable) return []
        return [`- ${goal.id}「${goal.title}」：剩余 ${remaining} 分钟 > 截止前可用 ${usable} 分钟`]
      })

      const sections = [
        goals.length === 0 ? '目标：暂无（用 planner_goal_create 建一个）' : `目标 ${goals.length} 个：\n${goalLines.join('\n')}`,
        dayLines.length === 0 ? `日期负载：${start} ~ ${end} 没有已排期任务` : `日期负载：${dayLines.join('；')}`,
        risky.length === 0 ? '风险：无' : `风险：\n${risky.join('\n')}`,
      ]
      return sections.join('\n')
    },
  })

  return [goalCreate, planPropose, planCommit, taskQuery, taskUpdate, overview]
}
