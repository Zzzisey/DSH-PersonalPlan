import type {
  CapacityRules,
  CheckKind,
  Draft,
  DraftMode,
  DraftStatus,
  Goal,
  GoalStatus,
  Issue,
  Phase,
  Priority,
  Task,
  TaskStatus,
  Verdict,
} from '../core/types.js'

export interface CreateGoalInput {
  title: string
  motivation?: string
  deadline?: string
}

export interface GoalPatch {
  title?: string
  motivation?: string | null
  deadline?: string | null
  status?: GoalStatus
}

export interface CreatePhaseInput {
  goalId: string
  title: string
  seq: number
  startDay?: string
  endDay?: string
}

export interface CreateTaskInput {
  goalId?: string
  phaseId?: string
  title: string
  day?: string
  estMinutes?: number
  priority?: Priority
  note?: string
}

export interface TaskFilter {
  from?: string
  to?: string
  goalId?: string
  status?: TaskStatus
  includeDropped?: boolean
  limit?: number
}

export interface TaskPatch {
  id: string
  title?: string
  day?: string | null
  estMinutes?: number
  priority?: Priority
  status?: TaskStatus
  actualMinutes?: number | null
  note?: string | null
}

export interface CreateDraftInput {
  goalId?: string
  mode: DraftMode
  payload: unknown
}

export interface CheckEntry {
  kind: CheckKind
  target: string
  verdict: Verdict
  issues: Issue[]
  model?: string
}

/** PlannerService 与持久化之间的窄边界；实现负责 SQL、条件写入与事务。 */
export interface PlannerRepository {
  createGoal(input: CreateGoalInput): Goal
  getGoal(id: string): Goal | undefined
  listGoals(status?: string): Goal[]
  updateGoal(id: string, patch: GoalPatch): Goal | undefined

  createPhase(input: CreatePhaseInput): Phase
  listPhases(goalId: string): Phase[]
  createTask(input: CreateTaskInput): Task
  getTask(id: string): Task | undefined
  listTasks(filter?: TaskFilter): Task[]
  updateTasks(patches: TaskPatch[]): Task[]

  createDraft(input: CreateDraftInput): Draft
  getDraft(id: string): Draft | undefined
  updateDraftPayload(id: string, payload: unknown): Draft
  setDraftVerdict(id: string, verdict: Verdict): void
  setDraftStatus(id: string, status: DraftStatus): void
  setDraftDecision(id: string, required: boolean, options: unknown): void

  appendCheck(entry: CheckEntry): void
  getCapacity(): CapacityRules
  setCapacity(rules: CapacityRules): void
  transaction<T>(fn: () => T): T
}
