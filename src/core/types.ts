/** Personal Planner 的领域类型。字段命名与 tool / SQL 的对外形状一致。 */

export type GoalStatus = 'active' | 'done' | 'dropped'
export type PhaseStatus = 'planned' | 'active' | 'done' | 'dropped'
export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped'
export type Priority = 'P0' | 'P1' | 'P2'
export type Verdict = 'pass' | 'warn' | 'fail' | 'unverified'
export type DraftStatus = 'open' | 'committed' | 'discarded'
export type DraftMode = 'new' | 'adjust'
export type CheckKind = 'capacity' | 'semantic' | 'commit' | 'override'

export interface Goal {
  id: string
  title: string
  motivation: string | null
  deadline: string | null
  status: GoalStatus
  createdAt: string
  updatedAt: string
}

export interface Phase {
  id: string
  goalId: string
  title: string
  seq: number
  startDay: string | null
  endDay: string | null
  status: PhaseStatus
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  goalId: string | null
  phaseId: string | null
  title: string
  day: string | null
  estMinutes: number
  actualMinutes: number | null
  priority: Priority
  status: TaskStatus
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface Draft {
  id: string
  goalId: string | null
  mode: DraftMode
  payloadJson: string
  verdict: Verdict | null
  status: DraftStatus
  decisionRequired: number
  optionsJson: string | null
  createdAt: string
  expiresAt: string
}

/** 一条结构化校验发现；`where` 用阶段/任务在提案里的下标定位，便于模型局部修。 */
export interface ValidationIssue {
  kind: string
  severity: 'info' | 'warn' | 'fail'
  message: string
  suggestion?: string
  where?: { phaseIndex?: number; taskIndex?: number }
  taskId?: string
  day?: string
  /** 处置方式：只提示 / 需要用户决定（HITL）/ 数据错误直接拒绝。 */
  blocking?: 'none' | 'decision' | 'invalid'
}

/** legacy 兼容名称；现有 Tool、Judge、Repo 在后续边界迁移前继续使用。 */
export type Issue = ValidationIssue

/** 单日容量报告。`load = planned / limit`。 */
export interface DayLoad {
  day: string
  planned: number
  limit: number
  load: number
  unplannedCount?: number
}

/** 容量规则；存在 setting 表的 `capacity` 键里。 */
export interface CapacityRules {
  weekdayMinutes: number
  weekendMinutes: number
  overrides: Record<string, number>
}

// ---------------------------------------------------------------- staged proposal storage contracts

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ProposalOperation = 'create' | 'reschedule' | 'modify' | 'replan'
export type PlanningStage = 'structure' | 'estimate' | 'schedule' | 'ready'
export type ProposalStatus = 'editing' | 'awaiting_confirmation' | 'committed' | 'discarded' | 'stale'
export type PhaseLocalId = string
export type TaskLocalId = string

export type CompletionSnapshot =
  | { isCompleted: false; completedAt: null }
  | { isCompleted: true; completedAt: string | null }

export interface PlanSnapshotV1 {
  schemaVersion: 1
  goal: {
    id: string
    title: string
    acceptanceCriteria: string | null
    deadline: string | null
    status: GoalStatus
  }
  phases: Array<{
    id: string
    title: string
    acceptanceCriteria: string | null
    seq: number
    completion: CompletionSnapshot
    tasks: Array<{
      id: string
      title: string
      priority: Priority
      estMinutes: number
      day: string | null
      seq: number
      completion: CompletionSnapshot
      actualMinutes: number | null
      note: string | null
    }>
  }>
}

export interface ProposalTaskSnapshot {
  localId: TaskLocalId
  sourceTaskId: string | null
  title: string
  priority: Priority
  seq: number
  completion: CompletionSnapshot
  estMinutes: number | null
  day: string | null
  actualMinutes: number | null
  note: string | null
}

export interface ProposalPhaseSnapshot {
  localId: PhaseLocalId
  sourcePhaseId: string | null
  title: string
  acceptanceCriteria: string
  seq: number
  completion: CompletionSnapshot
  tasks: ProposalTaskSnapshot[]
}

export interface ProposalSnapshotV1 {
  schemaVersion: 1
  phases: ProposalPhaseSnapshot[]
}

export interface OrderingConstraint {
  predecessorTaskLocalId: TaskLocalId
  successorTaskLocalId: TaskLocalId
  strength: 'required' | 'preferred'
  reason: string
}

export interface ProposalValidationIssue {
  code: string
  message: string
  phaseLocalId?: PhaseLocalId
  taskLocalId?: TaskLocalId
  day?: string
}

export interface CapacityValidationDay {
  day: string
  limitMinutes: number
  externalPlannedMinutes: number
  candidatePlannedMinutes: number
}

export type ProposalValidationV1 =
  | { schemaVersion: 1; state: 'pending' }
  | {
      schemaVersion: 1
      state: 'evaluated'
      validatedRevision: number
      checkedStage: 'structure' | 'estimate'
      verdict: 'valid' | 'invalid'
      issues: ProposalValidationIssue[]
    }
  | {
      schemaVersion: 1
      state: 'evaluated'
      validatedRevision: number
      checkedStage: 'schedule'
      verdict: 'valid' | 'invalid'
      issues: ProposalValidationIssue[]
      orderingConstraints: OrderingConstraint[]
      capacityDays: CapacityValidationDay[]
      scheduleVersion: number
    }

export interface PlanProposal {
  id: string
  goalId: string
  ownerSessionId: string
  operation: ProposalOperation
  stage: PlanningStage
  status: ProposalStatus
  revision: number
  baseScheduleVersion: number
  baseline: PlanSnapshotV1
  candidate: ProposalSnapshotV1
  validation: ProposalValidationV1
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

/** Agent 阶段输入；与持久化的完整 Candidate 分离。 */
export interface StructureProposalCommand {
  phases: Array<{
    title: string
    acceptanceCriteria: string
    seq: number
    tasks: Array<{ title: string; priority: Priority; seq: number }>
  }>
}

export interface EstimateProposalCommand {
  tasks: Array<{ taskLocalId: TaskLocalId; estMinutes: number }>
}

export interface ScheduleProposalCommand {
  tasks: Array<{ taskLocalId: TaskLocalId; day: string }>
  orderingConstraints: OrderingConstraint[]
}
