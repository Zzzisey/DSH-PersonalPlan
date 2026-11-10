/**
 * Agent 工具：六个 defineTool。
 *
 * 三条统一约定（DESIGN §6）：返回自然语言字符串；可预期失败返回 `错误：…` 而不是抛异常；
 * 写操作整批事务。
 * @module @local/planner/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { addDays, todayInShanghai } from './core/validation/capacity.js'
import type { DayLoad, DraftMode, GoalStatus, Priority, Task, TaskStatus } from './core/types.js'
import { PlannerService, type LegacyDraftPayload, type LegacyDraftTask } from './host/planner-service.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2']
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'dropped']

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

/** 把 propose 入参解析成 payload；出错时返回可读字符串。 */
function parsePayload(phasesRaw: unknown, looseRaw: unknown): LegacyDraftPayload | string {
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) return 'phases 必须是非空数组'
  const phases: LegacyDraftPayload['phases'] = []
  for (const [phaseIndex, rawPhase] of phasesRaw.entries()) {
    const phase = (typeof rawPhase === 'object' && rawPhase !== null ? rawPhase : {}) as Record<string, unknown>
    const title = str(phase.title)
    if (title === undefined) return `phases[${phaseIndex}].title 必填`
    const startDay = parseDate(phase.start_day ?? phase.startDay)
    const endDay = parseDate(phase.end_day ?? phase.endDay)
    if (startDay === null || endDay === null) return `phases[${phaseIndex}] 的日期必须是 YYYY-MM-DD`
    const tasksRaw = phase.tasks
    if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return `phases[${phaseIndex}].tasks 必须是非空数组`
    const tasks: LegacyDraftTask[] = []
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
  const looseTasks: LegacyDraftTask[] = []
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

function parseDraftTask(raw: unknown, at: string): LegacyDraftTask | string {
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

/**
 * 构造六个工具。
 * @param service - 唯一业务入口。
 * @returns 可直接交给 `ctx.tools.register` 的定义数组。
 */
export function createPlannerTools(service: PlannerService) {
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
      const goal = service.createGoal({
        title,
        ...(motivation === undefined ? {} : { motivation }),
        ...(deadline === undefined ? {} : { deadline }),
      })
      const tail = goal.deadline === null ? '' : `（截止 ${goal.deadline}）`
      return `已创建目标「${goal.title}」${goal.id}${tail}。下一步：用 planner_plan_propose 提交计划。`
    },
  })

  const goalUpdate = defineTool({
    name: 'planner_goal_update',
    description:
      '修改已有目标：状态（active/done/dropped）、标题、动机、截止日期。'
      + '用于「这个目标做完了」「不做了」「截止延到某天」。只改目标记录，**不删除任何任务**；'
      + '放弃目标后如需清理任务，再单独用 planner_task_update 处理。',
    parameters: {
      goal_id: { type: 'string', required: true, description: '要修改的目标 id' },
      status: { type: 'string', enum: ['active', 'done', 'dropped'], description: 'active=进行中，done=已完成，dropped=放弃但保留记录' },
      title: { type: 'string', description: '新标题' },
      motivation: { type: 'string', description: '新的动机说明' },
      deadline: { type: 'string', description: '新截止日期 YYYY-MM-DD；传空串表示清除截止' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const goalId = str(args.goal_id)
      if (goalId === undefined) return bad('goal_id 必填')
      const goal = service.getGoal(goalId)
      if (goal === undefined) return bad(`目标 ${goalId} 不存在`)

      const statusRaw = str(args.status)
      if (statusRaw !== undefined && statusRaw !== 'active' && statusRaw !== 'done' && statusRaw !== 'dropped') {
        return bad('status 只能是 active / done / dropped')
      }
      const deadlineRaw = args.deadline === undefined ? undefined : args.deadline
      const deadline = deadlineRaw === '' ? null : parseDate(deadlineRaw)
      if (deadlineRaw !== undefined && deadline === null && deadlineRaw !== '') {
        return bad('deadline 必须是 YYYY-MM-DD，或空串表示清除')
      }
      const title = str(args.title)
      const motivation = args.motivation === undefined ? undefined : str(args.motivation) ?? ''

      if (statusRaw === undefined && title === undefined && motivation === undefined && deadline === undefined) {
        return bad('至少提供一个要改的字段：status / title / motivation / deadline')
      }

      const updated = service.updateGoal(goalId, {
        ...(statusRaw === undefined ? {} : { status: statusRaw as GoalStatus }),
        ...(title === undefined ? {} : { title }),
        ...(motivation === undefined ? {} : { motivation }),
        ...(deadline === undefined ? {} : { deadline }),
      })
      if (updated === undefined) return bad(`目标 ${goalId} 不存在`)
      const changes = [
        statusRaw === undefined ? '' : `状态 ${updated.status}`,
        title === undefined ? '' : `标题「${updated.title}」`,
        motivation === undefined ? '' : '动机已更新',
        deadline === undefined ? '' : (updated.deadline === null ? '截止日期已清除' : `截止 ${updated.deadline}`),
      ].filter((part) => part !== '').join('；')
      return `已更新目标「${updated.title}」（${updated.id}）：${changes}。任务未做任何改动。`
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
      if (service.getGoal(goalId) === undefined) return bad(`目标 ${goalId} 不存在`)

      const payload = parsePayload(args.phases, args.loose_tasks)
      if (typeof payload === 'string') return bad(payload)

      const modeRaw = str(args.mode)
      const mode: DraftMode = modeRaw === 'adjust' ? 'adjust' : 'new'
      const draftId = str(args.draft_id)
      return service.legacyPropose({
        goalId,
        payload,
        mode,
        ...(draftId === undefined ? {} : { draftId }),
      })
    },
  })

  const planCommit = defineTool({
    name: 'planner_plan_commit',
    description:
      '把一份草稿真正落库（阶段与任务）。只有用户明确确认后才调用。'
      + '结构性错误（日期不合理、一天超过 12 小时等）直接拒绝；容量或语义问题不硬拒，'
      + '但需要用户选一个 decision：accept_overload（接受超载/超期）、apply_reschedule（按建议挪动）、'
      + 'shrink（砍任务或压缩工时）。提交前会重算容量，propose 之后被改过也能发现。',
    parameters: {
      draft_id: { type: 'string', required: true, description: 'planner_plan_propose 返回的草稿 id' },
      decision: {
        type: 'string',
        enum: ['accept_overload', 'apply_reschedule', 'shrink'],
        description: '结论为 needs_decision 时必填：用户选择如何处理',
      },
      reason: { type: 'string', description: '用户为什么这样决定；会写进 check_log 的 override 记录' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: Record<string, unknown>) {
      const draftId = str(args.draft_id)
      if (draftId === undefined) return bad('draft_id 必填')
      const decision = str(args.decision)
      const reason = str(args.reason)
      return service.legacyCommit({
        draftId,
        ...(decision === undefined ? {} : { decision }),
        ...(reason === undefined ? {} : { reason }),
      })
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

      const tasks = service.queryTasks({
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

      const patches: Parameters<PlannerService['updateTasks']>[0] = []
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

      let result: ReturnType<PlannerService['updateTasks']>
      try {
        result = service.updateTasks(patches)
      } catch (error) {
        return bad(error instanceof Error ? error.message : String(error))
      }

      const overloaded = (result.report?.days ?? []).filter((day) => day.planned > day.limit).map(formatDay)
      const note = overloaded.length === 0 ? '' : `\n注意：${overloaded.join('；')} 已超载，建议挪任务或拆小。`
      return `已更新 ${result.tasks.length} 个任务。${note}`
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

      const view = service.queryOverview(start, end, goalId)
      const goalLines = view.goals.map(({ goal, done, total, percent }) => {
        const deadline = goal.deadline === null ? '无截止' : `截止 ${goal.deadline}`
        return `- 「${goal.title}」${done}/${total}（${percent}%），${deadline}`
      })
      const dayLines = view.days.map(formatDay)
      const risky = view.risks.map((risk) => `- ${risk.goalId}「${risk.title}」：剩余 ${risk.remaining} 分钟 > 截止前可用 ${risk.usable} 分钟`)

      const sections = [
        view.goals.length === 0 ? '目标：暂无（用 planner_goal_create 建一个）' : `目标 ${view.goals.length} 个：\n${goalLines.join('\n')}`,
        dayLines.length === 0 ? `日期负载：${start} ~ ${end} 没有已排期任务` : `日期负载：${dayLines.join('；')}`,
        risky.length === 0 ? '风险：无' : `风险：\n${risky.join('\n')}`,
      ]
      return sections.join('\n')
    },
  })

  return [goalCreate, goalUpdate, planPropose, planCommit, taskQuery, taskUpdate, overview]
}
