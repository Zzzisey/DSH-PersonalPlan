import type { DatabaseSync } from 'node:sqlite'
import {
  appendCheck,
  createDraft,
  createGoal,
  createPhase,
  createTask,
  getCapacity,
  getDraft,
  getGoal,
  getTask,
  listGoals,
  listPhases,
  listTasks,
  setCapacity,
  setDraftDecision,
  setDraftStatus,
  setDraftVerdict,
  transaction,
  updateDraftPayload,
  updateGoal,
  updateTasks,
} from '../db/repo.js'
import type {
  CheckEntry,
  CreateDraftInput,
  CreateGoalInput,
  CreatePhaseInput,
  CreateTaskInput,
  GoalPatch,
  PlannerRepository,
  TaskFilter,
  TaskPatch,
} from './repository.js'
import type { CapacityRules, DraftStatus, Verdict } from '../core/types.js'

/** 现有函数式 Repo 的 SQLite adapter；阶段三只改变调用边界，不改变 SQL。 */
export class SqlitePlannerRepository implements PlannerRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  createGoal(input: CreateGoalInput) { return createGoal(this.db, input) }
  getGoal(id: string) { return getGoal(this.db, id) }
  listGoals(status?: string) { return listGoals(this.db, status) }
  updateGoal(id: string, patch: GoalPatch) { return updateGoal(this.db, id, patch) }

  createPhase(input: CreatePhaseInput) { return createPhase(this.db, input) }
  listPhases(goalId: string) { return listPhases(this.db, goalId) }
  createTask(input: CreateTaskInput) { return createTask(this.db, input) }
  getTask(id: string) { return getTask(this.db, id) }
  listTasks(filter: TaskFilter = {}) { return listTasks(this.db, filter) }
  updateTasks(patches: TaskPatch[]) { return updateTasks(this.db, patches) }

  createDraft(input: CreateDraftInput) { return createDraft(this.db, input) }
  getDraft(id: string) { return getDraft(this.db, id) }
  updateDraftPayload(id: string, payload: unknown) { return updateDraftPayload(this.db, id, payload) }
  setDraftVerdict(id: string, verdict: Verdict) { setDraftVerdict(this.db, id, verdict) }
  setDraftStatus(id: string, status: DraftStatus) { setDraftStatus(this.db, id, status) }
  setDraftDecision(id: string, required: boolean, options: unknown) { setDraftDecision(this.db, id, required, options) }

  appendCheck(entry: CheckEntry) { appendCheck(this.db, entry) }
  getCapacity(): CapacityRules { return getCapacity(this.db) }
  setCapacity(rules: CapacityRules) { setCapacity(this.db, rules) }
  transaction<T>(fn: () => T): T { return transaction(this.db, fn) }
}
