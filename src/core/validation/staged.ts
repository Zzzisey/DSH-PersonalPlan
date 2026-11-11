import {
  ESTIMATE_STEP_MINUTES,
  MAX_ESTIMATE_MINUTES,
  MAX_PHASE_TASKS,
  MAX_PROPOSAL_PHASES,
  MIN_ESTIMATE_MINUTES,
  MIN_PHASE_TASKS,
  MIN_PROPOSAL_PHASES,
} from '../policy.js'
import type {
  EstimateProposalCommand,
  OrderingConstraint,
  ProposalSnapshotV1,
  ProposalValidationIssue,
  ScheduleProposalCommand,
  StructureProposalCommand,
} from '../types.js'

function issue(code: string, message: string, taskLocalId?: string): ProposalValidationIssue {
  return { code, message, ...(taskLocalId === undefined ? {} : { taskLocalId }) }
}

function continuous(values: number[]): boolean {
  return [...values].sort((a, b) => a - b).every((value, index) => value === index + 1)
}

export function validateStructure(command: StructureProposalCommand): ProposalValidationIssue[] {
  const issues: ProposalValidationIssue[] = []
  if (command.phases.length < MIN_PROPOSAL_PHASES || command.phases.length > MAX_PROPOSAL_PHASES) {
    issues.push(issue('PHASE_COUNT', `阶段数量必须为 ${MIN_PROPOSAL_PHASES}–${MAX_PROPOSAL_PHASES}`))
  }
  if (!continuous(command.phases.map((phase) => phase.seq))) issues.push(issue('PHASE_SEQ', '阶段 seq 必须从 1 连续排列'))
  const phaseTitles = new Set<string>()
  for (const phase of command.phases) {
    if (phase.title.trim() === '' || phase.acceptanceCriteria.trim().length < 1 || phase.acceptanceCriteria.trim().length > 1000) {
      issues.push(issue('PHASE_FIELDS', '阶段标题和 1–1000 字验收标准必填'))
    }
    const normalized = phase.title.trim().toLocaleLowerCase()
    if (phaseTitles.has(normalized)) issues.push(issue('DUPLICATE_PHASE', `阶段标题重复：${phase.title}`))
    phaseTitles.add(normalized)
    if (phase.tasks.length < MIN_PHASE_TASKS || phase.tasks.length > MAX_PHASE_TASKS) {
      issues.push(issue('TASK_COUNT', `每阶段任务数量必须为 ${MIN_PHASE_TASKS}–${MAX_PHASE_TASKS}`))
    }
    if (!continuous(phase.tasks.map((task) => task.seq))) issues.push(issue('TASK_SEQ', `阶段「${phase.title}」的任务 seq 必须连续`))
    const taskTitles = new Set<string>()
    for (const task of phase.tasks) {
      if (task.title.trim() === '') issues.push(issue('TASK_TITLE', '任务标题不能为空'))
      const taskTitle = task.title.trim().toLocaleLowerCase()
      if (taskTitles.has(taskTitle)) issues.push(issue('DUPLICATE_TASK', `任务标题重复：${task.title}`))
      taskTitles.add(taskTitle)
    }
  }
  return issues
}

export function validateEstimate(candidate: ProposalSnapshotV1, command: EstimateProposalCommand): ProposalValidationIssue[] {
  const expected = candidate.phases.flatMap((phase) => phase.tasks.map((task) => task.localId)).sort()
  const received = command.tasks.map((task) => task.taskLocalId).sort()
  const issues: ProposalValidationIssue[] = []
  if (JSON.stringify(expected) !== JSON.stringify(received) || new Set(received).size !== received.length) {
    issues.push(issue('TASK_SET_CHANGED', '估时必须且只能覆盖现有全部任务'))
  }
  for (const task of command.tasks) {
    if (!Number.isInteger(task.estMinutes) || task.estMinutes < MIN_ESTIMATE_MINUTES
      || task.estMinutes > MAX_ESTIMATE_MINUTES || task.estMinutes % ESTIMATE_STEP_MINUTES !== 0) {
      issues.push(issue('ESTIMATE_INVALID', '估时必须为 15–120 分钟且是 15 的倍数', task.taskLocalId))
    }
  }
  return issues
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
}

function hasRequiredCycle(constraints: OrderingConstraint[]): boolean {
  const edges = new Map<string, string[]>()
  for (const edge of constraints.filter((item) => item.strength === 'required')) {
    edges.set(edge.predecessorTaskLocalId, [...(edges.get(edge.predecessorTaskLocalId) ?? []), edge.successorTaskLocalId])
  }
  const active = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): boolean => {
    if (active.has(id)) return true
    if (done.has(id)) return false
    active.add(id)
    if ((edges.get(id) ?? []).some(visit)) return true
    active.delete(id)
    done.add(id)
    return false
  }
  return [...edges.keys()].some(visit)
}

export interface ScheduleValidationContext {
  deadline: string | null
  capacityFor(day: string): number
  externalMinutes: ReadonlyMap<string, number>
}

export function validateSchedule(
  candidate: ProposalSnapshotV1,
  command: ScheduleProposalCommand,
  context: ScheduleValidationContext,
): ProposalValidationIssue[] {
  const expected = candidate.phases.flatMap((phase) => phase.tasks.map((task) => task.localId)).sort()
  const received = command.tasks.map((task) => task.taskLocalId).sort()
  const issues: ProposalValidationIssue[] = []
  if (JSON.stringify(expected) !== JSON.stringify(received) || new Set(received).size !== received.length) {
    issues.push(issue('TASK_SET_CHANGED', '排期必须且只能覆盖现有全部任务'))
  }
  const dayByTask = new Map(command.tasks.map((task) => [task.taskLocalId, task.day]))
  const taskIds = new Set(expected)
  for (const task of command.tasks) {
    if (!validDay(task.day)) issues.push(issue('DAY_INVALID', '日期必须是有效的 YYYY-MM-DD', task.taskLocalId))
    if (context.deadline !== null && task.day > context.deadline) issues.push(issue('DEADLINE_EXCEEDED', '任务日期超过目标截止日', task.taskLocalId))
  }
  const edgeKeys = new Set<string>()
  for (const edge of command.orderingConstraints) {
    const key = `${edge.predecessorTaskLocalId}\0${edge.successorTaskLocalId}`
    if (!taskIds.has(edge.predecessorTaskLocalId) || !taskIds.has(edge.successorTaskLocalId)
      || edge.predecessorTaskLocalId === edge.successorTaskLocalId || edgeKeys.has(key)) {
      issues.push(issue('ORDERING_INVALID', '依赖存在悬空、自引用或重复边'))
    }
    edgeKeys.add(key)
    if (edge.strength === 'required') {
      const before = dayByTask.get(edge.predecessorTaskLocalId)
      const after = dayByTask.get(edge.successorTaskLocalId)
      if (before !== undefined && after !== undefined && before >= after) {
        issues.push(issue('REQUIRED_ORDER_VIOLATION', 'required 依赖必须安排在更早日期', edge.successorTaskLocalId))
      }
    }
  }
  if (hasRequiredCycle(command.orderingConstraints)) issues.push(issue('ORDERING_CYCLE', 'required 依赖不能成环'))
  const candidateMinutes = new Map<string, number>()
  for (const phase of candidate.phases) for (const task of phase.tasks) {
    const taskDay = dayByTask.get(task.localId)
    if (taskDay !== undefined && task.estMinutes !== null) candidateMinutes.set(taskDay, (candidateMinutes.get(taskDay) ?? 0) + task.estMinutes)
  }
  for (const [taskDay, minutes] of candidateMinutes) {
    if ((context.externalMinutes.get(taskDay) ?? 0) + minutes > context.capacityFor(taskDay)) {
      issues.push({ code: 'CAPACITY_EXCEEDED', message: '候选计划超过当日容量', day: taskDay })
    }
  }
  return issues
}
