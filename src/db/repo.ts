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
} from '../types.js'

const GOAL_COLUMNS = 'id, title, motivation, deadline, status, created_at AS createdAt, updated_at AS updatedAt'
const PHASE_COLUMNS = 'id, goal_id AS goalId, title, seq, start_day AS startDay, end_day AS endDay, status, created_at AS createdAt, updated_at AS updatedAt'
const TASK_COLUMNS = `id, goal_id AS goalId, phase_id AS phaseId, title, day,
  est_minutes AS estMinutes, actual_minutes AS actualMinutes, priority, status, note,
  created_at AS createdAt, updated_at AS updatedAt`
const DRAFT_COLUMNS = 'id, goal_id AS goalId, mode, payload_json AS payloadJson, verdict, status, decision_required AS decisionRequired, options_json AS optionsJson, created_at AS createdAt, expires_at AS expiresAt'

/** 草稿有效期 24 小时：跨轮可改，隔天作废。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

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
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
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

export function createGoal(db: DatabaseSync, input: CreateGoalInput): Goal {
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

export function getGoal(db: DatabaseSync, id: string): Goal | undefined {
  return db.prepare(`select ${GOAL_COLUMNS} from goal where id = ?`).get(id) as unknown as Goal | undefined
}

export function listGoals(db: DatabaseSync, status?: string): Goal[] {
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
}

/**
 * 修改已有目标。**不删除任务**：放弃目标只改状态，任务仍留给用户处理。
 * @param db - 连接。
 * @param id - 目标 id。
 * @param patch - 要改的字段；空补丁原样返回。
 * @returns 更新后的目标；目标不存在时 undefined。
 */
export function updateGoal(db: DatabaseSync, id: string, patch: GoalPatch): Goal | undefined {
  const current = getGoal(db, id)
  if (current === undefined) return undefined
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title.trim()) }
  if (patch.motivation !== undefined) { sets.push('motivation = ?'); values.push(patch.motivation) }
  if (patch.deadline !== undefined) { sets.push('deadline = ?'); values.push(patch.deadline) }
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status) }
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
}

export function createPhase(db: DatabaseSync, input: CreatePhaseInput): Phase {
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

export function listPhases(db: DatabaseSync, goalId: string): Phase[] {
  return db.prepare(`select ${PHASE_COLUMNS} from phase where goal_id = ? order by seq`).all(goalId) as unknown as Phase[]
}

export function createTask(db: DatabaseSync, input: CreateTaskInput): Task {
  const stamp = nowIso()
  const id = newId('t')
  db.prepare(`insert into task (id, goal_id, phase_id, title, day, est_minutes, priority, status, note, created_at, updated_at)
    values (?,?,?,?,?,?,?,'todo',?,?,?)`).run(
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
  )
  return getTask(db, id)!
}

export function getTask(db: DatabaseSync, id: string): Task | undefined {
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

export function listTasks(db: DatabaseSync, filter: TaskFilter = {}): Task[] {
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
export function updateTasks(db: DatabaseSync, patches: TaskPatch[]): Task[] {
  if (patches.length === 0) return []
  return transaction(db, () => patches.map((patch) => {
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
  }))
}

// ---------------------------------------------------------------- draft

export interface CreateDraftInput {
  goalId?: string
  mode: DraftMode
  payload: unknown
}

export function createDraft(db: DatabaseSync, input: CreateDraftInput): Draft {
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

export function getDraft(db: DatabaseSync, id: string): Draft | undefined {
  return db.prepare(`select ${DRAFT_COLUMNS} from draft where id = ?`).get(id) as unknown as Draft | undefined
}

export function updateDraftPayload(db: DatabaseSync, id: string, payload: unknown): Draft {
  db.prepare('update draft set payload_json = ? where id = ?').run(JSON.stringify(payload), id)
  return getDraft(db, id)!
}

export function setDraftVerdict(db: DatabaseSync, id: string, verdict: Verdict): void {
  db.prepare('update draft set verdict = ? where id = ?').run(verdict, id)
}

export function setDraftStatus(db: DatabaseSync, id: string, status: DraftStatus): void {
  db.prepare('update draft set status = ? where id = ?').run(status, id)
}

/**
 * 记录"这份草稿需要用户决定"，并保存选项清单。
 * @param db - 连接。
 * @param id - 草稿 id。
 * @param required - 是否需要用户决定。
 * @param options - 给用户的选项数组；不需要时传 undefined。
 */
export function setDraftDecision(db: DatabaseSync, id: string, required: boolean, options: unknown): void {
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

export function appendCheck(db: DatabaseSync, entry: CheckEntry): void {
  db.prepare(`insert into check_log (at, kind, target, verdict, issues_json, model) values (?,?,?,?,?,?)`).run(
    nowIso(),
    entry.kind,
    entry.target,
    entry.verdict,
    JSON.stringify(entry.issues),
    entry.model ?? null,
  )
}

export function readSetting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare('select value from setting where key = ?').get(key) as { value: string } | undefined
  if (row === undefined) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function writeSetting(db: DatabaseSync, key: string, value: unknown): void {
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
export function getCapacity(db: DatabaseSync): CapacityRules {
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
export function setCapacity(db: DatabaseSync, rules: CapacityRules): void {
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
