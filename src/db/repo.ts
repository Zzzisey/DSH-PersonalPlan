/**
 * 领域读写。只有这里写 SQL；上层的容量校验与工具都调这一层。
 * @module @local/planner/db/repo
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
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
  PlanProposal,
  ProposalStatus,
} from '../core/types.js'
import {
  decodePlanSnapshot,
  decodeProposalSnapshot,
  decodeProposalValidation,
  encodePlanSnapshot,
  encodeProposalSnapshot,
  encodeProposalValidation,
} from '../core/proposal-codec.js'

const GOAL_COLUMNS = 'id, title, motivation, deadline, status, created_at AS createdAt, updated_at AS updatedAt'
const PHASE_COLUMNS = 'id, goal_id AS goalId, title, seq, start_day AS startDay, end_day AS endDay, status, created_at AS createdAt, updated_at AS updatedAt'
const TASK_COLUMNS = `id, goal_id AS goalId, phase_id AS phaseId, title, day,
  est_minutes AS estMinutes, actual_minutes AS actualMinutes, priority, status, note,
  created_at AS createdAt, updated_at AS updatedAt`
const DRAFT_COLUMNS = 'id, goal_id AS goalId, mode, payload_json AS payloadJson, verdict, status, decision_required AS decisionRequired, options_json AS optionsJson, created_at AS createdAt, expires_at AS expiresAt'
const PROPOSAL_COLUMNS = `id, goal_id AS goalId, owner_session_id AS ownerSessionId,
  operation, stage, status, revision, base_schedule_version AS baseScheduleVersion,
  baseline_json AS baselineJson, candidate_json AS candidateJson, validation_json AS validationJson,
  created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt`

/** 草稿有效期 24 小时：跨轮可改，隔天作废。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export type PlannerStorageErrorCode =
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_OWNER_MISMATCH'
  | 'PROPOSAL_REVISION_CONFLICT'
  | 'PROPOSAL_TERMINAL'
  | 'PROPOSAL_DATA_CORRUPT'

export class PlannerStorageError extends Error {
  readonly code: PlannerStorageErrorCode

  constructor(code: PlannerStorageErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'PlannerStorageError'
    this.code = code
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(prefix: 'g' | 'p' | 't' | 'd'): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

/**
 * 单事务执行；用于「整批要么全成」的写操作。
 * @param db - 连接。
 * @param fn - 事务体；抛错即回滚。
 */
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 连接已回滚或断开 */ }
    throw error
  }
}

// ---------------------------------------------------------------- goal

export interface CreateGoalInput {
  title: string
  motivation?: string
  deadline?: string
}

function createGoal(db: DatabaseSync, input: CreateGoalInput): Goal {
  const stamp = nowIso()
  const id = newId('g')
  db.prepare(`insert into goal (id, title, motivation, deadline, status, created_at, updated_at)
    values (?,?,?,?,'active',?,?)`).run(
    id,
    input.title.trim(),
    input.motivation ?? null,
    input.deadline ?? null,
    stamp,
    stamp,
  )
  return getGoal(db, id)!
}

function getGoal(db: DatabaseSync, id: string): Goal | undefined {
  return db.prepare(`select ${GOAL_COLUMNS} from goal where id = ?`).get(id) as unknown as Goal | undefined
}

function listGoals(db: DatabaseSync, status?: string): Goal[] {
  const sql = status === undefined
    ? `select ${GOAL_COLUMNS} from goal order by created_at desc`
    : `select ${GOAL_COLUMNS} from goal where status = ? order by created_at desc`
  return (status === undefined
    ? db.prepare(sql).all()
    : db.prepare(sql).all(status)) as unknown as Goal[]
}

export interface GoalPatch {
  title?: string
  motivation?: string | null
  deadline?: string | null
  status?: GoalStatus
  acceptanceCriteria?: string | null
}

/**
 * 修改已有目标。**不删除任务**：放弃目标只改状态，任务仍留给用户处理。
 * @param db - 连接。
 * @param id - 目标 id。
 * @param patch - 要改的字段；空补丁原样返回。
 * @returns 更新后的目标；目标不存在时 undefined。
 */
function updateGoal(db: DatabaseSync, id: string, patch: GoalPatch): Goal | undefined {
  const current = getGoal(db, id)
  if (current === undefined) return undefined
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title.trim()) }
  if (patch.motivation !== undefined) { sets.push('motivation = ?'); values.push(patch.motivation) }
  if (patch.deadline !== undefined) { sets.push('deadline = ?'); values.push(patch.deadline) }
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status) }
  if (patch.acceptanceCriteria !== undefined) { sets.push('acceptance_criteria = ?'); values.push(patch.acceptanceCriteria) }
  if (sets.length === 0) return current
  sets.push('updated_at = ?')
  values.push(nowIso(), id)
  db.prepare(`update goal set ${sets.join(', ')} where id = ?`).run(...values as never[])
  return getGoal(db, id)
}

// ---------------------------------------------------------------- phase / task

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
  seq?: number
}

function createPhase(db: DatabaseSync, input: CreatePhaseInput): Phase {
  const stamp = nowIso()
  const id = newId('p')
  db.prepare(`insert into phase (id, goal_id, title, seq, start_day, end_day, status, created_at, updated_at)
    values (?,?,?,?,?,?,'planned',?,?)`).run(
    id,
    input.goalId,
    input.title,
    input.seq,
    input.startDay ?? null,
    input.endDay ?? null,
    stamp,
    stamp,
  )
  return db.prepare(`select ${PHASE_COLUMNS} from phase where id = ?`).get(id) as unknown as Phase
}

function listPhases(db: DatabaseSync, goalId: string): Phase[] {
  return db.prepare(`select ${PHASE_COLUMNS} from phase where goal_id = ? order by seq`).all(goalId) as unknown as Phase[]
}

function createTask(db: DatabaseSync, input: CreateTaskInput): Task {
  const stamp = nowIso()
  const id = newId('t')
  const nextSeq = input.seq ?? (db.prepare('select coalesce(max(seq), 0) + 1 as value from task where phase_id is ?')
    .get(input.phaseId ?? null) as { value: number }).value
  db.prepare(`insert into task (id, goal_id, phase_id, title, day, est_minutes, priority, status, note, created_at, updated_at, seq)
    values (?,?,?,?,?,?,?,'todo',?,?,?,?)`).run(
    id,
    input.goalId ?? null,
    input.phaseId ?? null,
    input.title.trim(),
    input.day ?? null,
    input.estMinutes ?? 30,
    input.priority ?? 'P2',
    input.note ?? null,
    stamp,
    stamp,
    nextSeq,
  )
  return getTask(db, id)!
}

function getTask(db: DatabaseSync, id: string): Task | undefined {
  return db.prepare(`select ${TASK_COLUMNS} from task where id = ?`).get(id) as unknown as Task | undefined
}

export interface TaskFilter {
  from?: string
  to?: string
  goalId?: string
  status?: TaskStatus
  includeDropped?: boolean
  limit?: number
}

function listTasks(db: DatabaseSync, filter: TaskFilter = {}): Task[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.from !== undefined) { clauses.push('day >= ?'); params.push(filter.from) }
  if (filter.to !== undefined) { clauses.push('day <= ?'); params.push(filter.to) }
  if (filter.goalId !== undefined) { clauses.push('goal_id = ?'); params.push(filter.goalId) }
  if (filter.status !== undefined) { clauses.push('status = ?'); params.push(filter.status) }
  if (filter.includeDropped !== true) clauses.push("status <> 'dropped'")
  const where = clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 200)
  const sql = `select ${TASK_COLUMNS} from task ${where} order by day is null, day, created_at limit ${limit}`
  return db.prepare(sql).all(...params as never[]) as unknown as Task[]
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

/**
 * 批量更新任务：**单事务**，任一条不存在或字段非法则整批回滚。
 * @param db - 连接。
 * @param patches - 补丁数组。
 * @returns 更新后的任务（按输入顺序）。
 */
function updateTasks(db: DatabaseSync, patches: TaskPatch[]): Task[] {
  if (patches.length === 0) return []
  return patches.map((patch) => {
    const current = getTask(db, patch.id)
    if (current === undefined) throw new Error(`任务 ${patch.id} 不存在`)
    const sets: string[] = []
    const values: unknown[] = []
    if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title.trim()) }
    if (patch.day !== undefined) { sets.push('day = ?'); values.push(patch.day) }
    if (patch.estMinutes !== undefined) { sets.push('est_minutes = ?'); values.push(patch.estMinutes) }
    if (patch.priority !== undefined) { sets.push('priority = ?'); values.push(patch.priority) }
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status) }
    if (patch.actualMinutes !== undefined) { sets.push('actual_minutes = ?'); values.push(patch.actualMinutes) }
    if (patch.note !== undefined) { sets.push('note = ?'); values.push(patch.note) }
    if (sets.length === 0) return current
    sets.push('updated_at = ?')
    values.push(nowIso(), patch.id)
    db.prepare(`update task set ${sets.join(', ')} where id = ?`).run(...values as never[])
    return getTask(db, patch.id)!
  })
}

// ---------------------------------------------------------------- draft

export interface CreateDraftInput {
  goalId?: string
  mode: DraftMode
  payload: unknown
}

function createDraft(db: DatabaseSync, input: CreateDraftInput): Draft {
  const stamp = new Date()
  const id = newId('d')
  db.prepare(`insert into draft (id, goal_id, mode, payload_json, verdict, status, decision_required, options_json, created_at, expires_at)
    values (?,?,?,?,null,'open',0,null,?,?)`).run(
    id,
    input.goalId ?? null,
    input.mode,
    JSON.stringify(input.payload),
    stamp.toISOString(),
    new Date(stamp.getTime() + DRAFT_TTL_MS).toISOString(),
  )
  return getDraft(db, id)!
}

function getDraft(db: DatabaseSync, id: string): Draft | undefined {
  return db.prepare(`select ${DRAFT_COLUMNS} from draft where id = ?`).get(id) as unknown as Draft | undefined
}

function updateDraftPayload(db: DatabaseSync, id: string, payload: unknown): Draft {
  db.prepare('update draft set payload_json = ? where id = ?').run(JSON.stringify(payload), id)
  return getDraft(db, id)!
}

function setDraftVerdict(db: DatabaseSync, id: string, verdict: Verdict): void {
  db.prepare('update draft set verdict = ? where id = ?').run(verdict, id)
}

function setDraftStatus(db: DatabaseSync, id: string, status: DraftStatus): void {
  db.prepare('update draft set status = ? where id = ?').run(status, id)
}

/**
 * 记录"这份草稿需要用户决定"，并保存选项清单。
 * @param db - 连接。
 * @param id - 草稿 id。
 * @param required - 是否需要用户决定。
 * @param options - 给用户的选项数组；不需要时传 undefined。
 */
function setDraftDecision(db: DatabaseSync, id: string, required: boolean, options: unknown): void {
  db.prepare('update draft set decision_required = ?, options_json = ? where id = ?').run(
    required ? 1 : 0,
    options === undefined ? null : JSON.stringify(options),
    id,
  )
}

// ---------------------------------------------------------------- check_log / setting

export interface CheckEntry {
  kind: CheckKind
  target: string
  verdict: Verdict
  issues: Issue[]
  model?: string
}

function appendCheck(db: DatabaseSync, entry: CheckEntry): void {
  db.prepare(`insert into check_log (at, kind, target, verdict, issues_json, model) values (?,?,?,?,?,?)`).run(
    nowIso(),
    entry.kind,
    entry.target,
    entry.verdict,
    JSON.stringify(entry.issues),
    entry.model ?? null,
  )
}

function readSetting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare('select value from setting where key = ?').get(key) as { value: string } | undefined
  if (row === undefined) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

function writeSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(`insert into setting (key, value, updated_at) values (?,?,?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`).run(
    key,
    JSON.stringify(value),
    nowIso(),
  )
}

const CAPACITY_KEY = 'capacity'

/** 默认容量：工作日 240、周末 120，与 DESIGN §8.1 一致。 */
export const DEFAULT_CAPACITY: CapacityRules = {
  weekdayMinutes: 240,
  weekendMinutes: 120,
  overrides: {},
}

/** 读取容量规则；缺失或损坏时回落到 `DEFAULT_CAPACITY`。 */
function getCapacity(db: DatabaseSync): CapacityRules {
  const raw = readSetting<Partial<CapacityRules>>(db, CAPACITY_KEY, {})
  const weekday = typeof raw.weekdayMinutes === 'number' ? raw.weekdayMinutes : DEFAULT_CAPACITY.weekdayMinutes
  const weekend = typeof raw.weekendMinutes === 'number' ? raw.weekendMinutes : DEFAULT_CAPACITY.weekendMinutes
  const overrides = typeof raw.overrides === 'object' && raw.overrides !== null ? raw.overrides : {}
  return { weekdayMinutes: weekday, weekendMinutes: weekend, overrides }
}

/**
 * 写入容量规则并做范围校验。
 * @param db - 连接。
 * @param rules - 新规则。
 * @throws 当数值不是 30..1440 的整数时。
 */
function setCapacity(db: DatabaseSync, rules: CapacityRules): void {
  const check = (value: number, label: string): void => {
    if (!Number.isInteger(value) || value < 30 || value > 1440) {
      throw new Error(`${label} 必须是 30..1440 的整数`)
    }
  }
  check(rules.weekdayMinutes, '工作日容量')
  check(rules.weekendMinutes, '周末容量')
  for (const [day, minutes] of Object.entries(rules.overrides)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`覆盖日期格式应为 YYYY-MM-DD：${day}`)
    check(minutes, `${day} 的容量`)
  }
  writeSetting(db, CAPACITY_KEY, rules)
}

// ---------------------------------------------------------------- staged proposal

function mapProposal(rowValue: unknown): PlanProposal {
  const row = rowValue as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  try {
    const text = (key: string): string => {
      const value = row[key]
      if (typeof value !== 'string' || value === '') throw new TypeError(`${key} 非法`)
      return value
    }
    const integer = (key: string): number => {
      const value = row[key]
      if (!Number.isSafeInteger(value)) throw new TypeError(`${key} 非法`)
      return value as number
    }
    const operation = text('operation')
    const stage = text('stage')
    const status = text('status')
    if (!['create', 'reschedule', 'modify', 'replan'].includes(operation)) throw new TypeError('operation 非法')
    if (!['structure', 'estimate', 'schedule', 'ready'].includes(stage)) throw new TypeError('stage 非法')
    if (!['editing', 'awaiting_confirmation', 'committed', 'discarded', 'stale'].includes(status)) throw new TypeError('status 非法')
    const expiresAt = row.expiresAt
    if (expiresAt !== null && typeof expiresAt !== 'string') throw new TypeError('expiresAt 非法')
    return {
      id: text('id'),
      goalId: text('goalId'),
      ownerSessionId: text('ownerSessionId'),
      operation: operation as PlanProposal['operation'],
      stage: stage as PlanProposal['stage'],
      status: status as PlanProposal['status'],
      revision: integer('revision'),
      baseScheduleVersion: integer('baseScheduleVersion'),
      baseline: decodePlanSnapshot(text('baselineJson'), id),
      candidate: decodeProposalSnapshot(text('candidateJson'), id),
      validation: decodeProposalValidation(text('validationJson'), id),
      createdAt: text('createdAt'),
      updatedAt: text('updatedAt'),
      expiresAt,
    }
  } catch (cause) {
    if (cause instanceof PlannerStorageError) throw cause
    throw new PlannerStorageError('PROPOSAL_DATA_CORRUPT', `提案 ${id || '<unknown>'} 数据损坏`, cause)
  }
}

function createProposal(db: DatabaseSync, proposal: PlanProposal): PlanProposal {
  db.prepare(`insert into plan_proposal (
    id, goal_id, owner_session_id, operation, stage, status, revision, base_schedule_version,
    baseline_json, candidate_json, validation_json, created_at, updated_at, expires_at
  ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    proposal.id,
    proposal.goalId,
    proposal.ownerSessionId,
    proposal.operation,
    proposal.stage,
    proposal.status,
    proposal.revision,
    proposal.baseScheduleVersion,
    encodePlanSnapshot(proposal.baseline),
    encodeProposalSnapshot(proposal.candidate),
    encodeProposalValidation(proposal.validation),
    proposal.createdAt,
    proposal.updatedAt,
    proposal.expiresAt,
  )
  return getProposal(db, proposal.id)
}

function findProposal(db: DatabaseSync, id: string): PlanProposal | undefined {
  const row = db.prepare(`select ${PROPOSAL_COLUMNS} from plan_proposal where id = ?`).get(id)
  return row === undefined ? undefined : mapProposal(row)
}

function getProposal(db: DatabaseSync, id: string): PlanProposal {
  const proposal = findProposal(db, id)
  if (proposal === undefined) throw new PlannerStorageError('PROPOSAL_NOT_FOUND', `提案 ${id} 不存在`)
  return proposal
}

function getProposalForOwner(db: DatabaseSync, id: string, ownerSessionId: string): PlanProposal {
  const proposal = getProposal(db, id)
  if (proposal.ownerSessionId !== ownerSessionId) {
    throw new PlannerStorageError('PROPOSAL_OWNER_MISMATCH', `提案 ${id} 不属于当前会话`)
  }
  return proposal
}

function listProposalsByStatus(db: DatabaseSync, status: ProposalStatus, ownerSessionId?: string): PlanProposal[] {
  const rows = ownerSessionId === undefined
    ? db.prepare(`select ${PROPOSAL_COLUMNS} from plan_proposal where status = ? order by updated_at desc`).all(status)
    : db.prepare(`select ${PROPOSAL_COLUMNS} from plan_proposal where status = ? and owner_session_id = ? order by updated_at desc`).all(status, ownerSessionId)
  return rows.map(mapProposal)
}

function updateProposal(db: DatabaseSync, proposal: PlanProposal, expectedRevision: number): PlanProposal {
  const result = db.prepare(`update plan_proposal set
    stage = ?, status = ?, revision = ?, candidate_json = ?, validation_json = ?, updated_at = ?, expires_at = ?
    where id = ? and revision = ? and status not in ('committed','discarded','stale')`).run(
    proposal.stage,
    proposal.status,
    proposal.revision,
    encodeProposalSnapshot(proposal.candidate),
    encodeProposalValidation(proposal.validation),
    proposal.updatedAt,
    proposal.expiresAt,
    proposal.id,
    expectedRevision,
  )
  if (result.changes === 1) return getProposal(db, proposal.id)
  const current = findProposal(db, proposal.id)
  if (current === undefined) throw new PlannerStorageError('PROPOSAL_NOT_FOUND', `提案 ${proposal.id} 不存在`)
  if (['committed', 'discarded', 'stale'].includes(current.status)) {
    throw new PlannerStorageError('PROPOSAL_TERMINAL', `提案 ${proposal.id} 已进入终态`)
  }
  throw new PlannerStorageError('PROPOSAL_REVISION_CONFLICT', `提案 ${proposal.id} revision 已变化`)
}

function getScheduleVersion(db: DatabaseSync): number {
  const row = db.prepare("select value from planner_meta where key = 'schedule_version'").get() as { value?: unknown } | undefined
  const value = row?.value
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new PlannerStorageError('PROPOSAL_DATA_CORRUPT', 'schedule_version 数据损坏')
  }
  return Number(value)
}

function incrementScheduleVersion(db: DatabaseSync): void {
  const current = getScheduleVersion(db)
  const result = db.prepare(`update planner_meta set value = ?, updated_at = ?
    where key = 'schedule_version' and value = ?`).run(String(current + 1), nowIso(), String(current))
  if (result.changes !== 1) throw new PlannerStorageError('PROPOSAL_DATA_CORRUPT', 'schedule_version 更新失败')
}

/** 将运行时数据访问绑定到一个 SQLite 连接。 */
export function createPlannerRepo(db: DatabaseSync) {
  let transactionDepth = 0
  let scheduleMutationPending = false

  const markScheduleMutation = (): void => { scheduleMutationPending = true }
  const runTransaction = <T>(fn: () => T): T => {
    if (transactionDepth > 0) return fn()
    transactionDepth = 1
    scheduleMutationPending = false
    try {
      return transaction(db, () => {
        const value = fn()
        if (scheduleMutationPending) incrementScheduleVersion(db)
        return value
      })
    } finally {
      transactionDepth = 0
      scheduleMutationPending = false
    }
  }
  const formalMutation = <T>(fn: () => T): T => runTransaction(() => {
    const value = fn()
    markScheduleMutation()
    return value
  })

  return {
    createGoal: (input: CreateGoalInput) => formalMutation(() => createGoal(db, input)),
    getGoal: (id: string) => getGoal(db, id),
    listGoals: (status?: string) => listGoals(db, status),
    updateGoal: (id: string, patch: GoalPatch) => runTransaction(() => {
      const before = getGoal(db, id)
      const beforeAcceptance = db.prepare('select acceptance_criteria as value from goal where id = ?').get(id) as { value: string | null } | undefined
      const updated = updateGoal(db, id, patch)
      if (before !== undefined && updated !== undefined && (
        before.title !== updated.title
        || before.deadline !== updated.deadline
        || before.status !== updated.status
        || (patch.acceptanceCriteria !== undefined && beforeAcceptance?.value !== patch.acceptanceCriteria)
      )) markScheduleMutation()
      return updated
    }),
    createPhase: (input: CreatePhaseInput) => formalMutation(() => createPhase(db, input)),
    listPhases: (goalId: string) => listPhases(db, goalId),
    createTask: (input: CreateTaskInput) => formalMutation(() => createTask(db, input)),
    getTask: (id: string) => getTask(db, id),
    listTasks: (filter: TaskFilter = {}) => listTasks(db, filter),
    updateTasks: (patches: TaskPatch[]) => patches.length === 0
      ? []
      : formalMutation(() => updateTasks(db, patches)),
    createDraft: (input: CreateDraftInput) => createDraft(db, input),
    getDraft: (id: string) => getDraft(db, id),
    updateDraftPayload: (id: string, payload: unknown) => updateDraftPayload(db, id, payload),
    setDraftVerdict: (id: string, verdict: Verdict) => setDraftVerdict(db, id, verdict),
    setDraftStatus: (id: string, status: DraftStatus) => setDraftStatus(db, id, status),
    setDraftDecision: (id: string, required: boolean, options: unknown) => setDraftDecision(db, id, required, options),
    appendCheck: (entry: CheckEntry) => appendCheck(db, entry),
    getCapacity: () => getCapacity(db),
    setCapacity: (rules: CapacityRules) => runTransaction(() => {
      const before = getCapacity(db)
      setCapacity(db, rules)
      if (JSON.stringify(before) !== JSON.stringify(rules)) markScheduleMutation()
    }),
    createProposal: (proposal: PlanProposal) => createProposal(db, proposal),
    getProposal: (id: string) => getProposal(db, id),
    getProposalForOwner: (id: string, ownerSessionId: string) => getProposalForOwner(db, id, ownerSessionId),
    listProposalsByStatus: (status: ProposalStatus, ownerSessionId?: string) => listProposalsByStatus(db, status, ownerSessionId),
    updateProposal: (proposal: PlanProposal, expectedRevision: number) => updateProposal(db, proposal, expectedRevision),
    getScheduleVersion: () => getScheduleVersion(db),
    transaction: <T>(fn: () => T) => runTransaction(fn),
  }
}

export type PlannerRepo = ReturnType<typeof createPlannerRepo>
