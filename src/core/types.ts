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

/** 一条校验发现；`where` 用阶段/任务在提案里的下标定位，便于模型局部修。 */
export interface Issue {
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
