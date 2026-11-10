import type {
  CapacityValidationDay,
  CompletionSnapshot,
  OrderingConstraint,
  PlanSnapshotV1,
  ProposalPhaseSnapshot,
  ProposalSnapshotV1,
  ProposalTaskSnapshot,
  ProposalValidationIssue,
  ProposalValidationV1,
} from './types.js'

export type ProposalJsonColumn = 'baseline_json' | 'candidate_json' | 'validation_json'

export class ProposalDataCorruptError extends Error {
  readonly code = 'PROPOSAL_DATA_CORRUPT'
  readonly proposalId: string
  readonly column: ProposalJsonColumn

  constructor(proposalId: string, column: ProposalJsonColumn, cause: unknown) {
    super(`提案 ${proposalId} 的 ${column} 已损坏`, { cause })
    this.name = 'ProposalDataCorruptError'
    this.proposalId = proposalId
    this.column = column
  }
}

type ObjectValue = Record<string, unknown>

function object(value: unknown, path: string): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} 必须是对象`)
  return value as ObjectValue
}

function exact(value: ObjectValue, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} 缺失`)
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key} 不是允许字段`)
  }
}

function string(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) throw new TypeError(`${path} 必须是字符串`)
  return value
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path)
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${path} 必须是安全整数`)
  return value
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : integer(value, path)
}

function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`${path} 枚举值非法`)
  return value as T
}

function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`)
  return value.map((item, index) => parse(item, `${path}[${index}]`))
}

function day(value: unknown, path: string): string {
  const result = string(value, path)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result)
  if (match === null) throw new TypeError(`${path} 必须是 YYYY-MM-DD`)
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (new Date(timestamp).toISOString().slice(0, 10) !== result) throw new TypeError(`${path} 日期非法`)
  return result
}

function nullableDay(value: unknown, path: string): string | null {
  return value === null ? null : day(value, path)
}

function nullableTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null
  const result = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) throw new TypeError(`${path} 时间非法`)
  return result
}

function completion(value: unknown, path: string): CompletionSnapshot {
  const row = object(value, path)
  exact(row, path, ['isCompleted', 'completedAt'])
  if (row.isCompleted === false) {
    if (row.completedAt !== null) throw new TypeError(`${path}.completedAt 未完成时必须为 null`)
    return { isCompleted: false, completedAt: null }
  }
  if (row.isCompleted === true) return { isCompleted: true, completedAt: nullableTimestamp(row.completedAt, `${path}.completedAt`) }
  throw new TypeError(`${path}.isCompleted 必须是布尔值`)
}

function planTask(value: unknown, path: string): PlanSnapshotV1['phases'][number]['tasks'][number] {
  const row = object(value, path)
  exact(row, path, ['id', 'title', 'priority', 'estMinutes', 'day', 'seq', 'completion', 'actualMinutes', 'note'])
  return {
    id: string(row.id, `${path}.id`, true),
    title: string(row.title, `${path}.title`),
    priority: oneOf(row.priority, `${path}.priority`, ['P0', 'P1', 'P2']),
    estMinutes: integer(row.estMinutes, `${path}.estMinutes`),
    day: nullableDay(row.day, `${path}.day`),
    seq: integer(row.seq, `${path}.seq`),
    completion: completion(row.completion, `${path}.completion`),
    actualMinutes: nullableInteger(row.actualMinutes, `${path}.actualMinutes`),
    note: nullableString(row.note, `${path}.note`),
  }
}

function planSnapshot(value: unknown): PlanSnapshotV1 {
  const row = object(value, 'baseline')
  exact(row, 'baseline', ['schemaVersion', 'goal', 'phases'])
  if (row.schemaVersion !== 1) throw new TypeError('baseline.schemaVersion 必须为 1')
  const goal = object(row.goal, 'baseline.goal')
  exact(goal, 'baseline.goal', ['id', 'title', 'acceptanceCriteria', 'deadline', 'status'])
  return {
    schemaVersion: 1,
    goal: {
      id: string(goal.id, 'baseline.goal.id', true),
      title: string(goal.title, 'baseline.goal.title'),
      acceptanceCriteria: nullableString(goal.acceptanceCriteria, 'baseline.goal.acceptanceCriteria'),
      deadline: nullableDay(goal.deadline, 'baseline.goal.deadline'),
      status: oneOf(goal.status, 'baseline.goal.status', ['active', 'done', 'dropped']),
    },
    phases: array(row.phases, 'baseline.phases', (phaseValue, path) => {
      const phase = object(phaseValue, path)
      exact(phase, path, ['id', 'title', 'acceptanceCriteria', 'seq', 'completion', 'tasks'])
      return {
        id: string(phase.id, `${path}.id`, true),
        title: string(phase.title, `${path}.title`),
        acceptanceCriteria: nullableString(phase.acceptanceCriteria, `${path}.acceptanceCriteria`),
        seq: integer(phase.seq, `${path}.seq`),
        completion: completion(phase.completion, `${path}.completion`),
        tasks: array(phase.tasks, `${path}.tasks`, planTask),
      }
    }),
  }
}

function proposalTask(value: unknown, path: string): ProposalTaskSnapshot {
  const row = object(value, path)
  exact(row, path, [
    'localId', 'sourceTaskId', 'title', 'priority', 'seq', 'completion',
    'estMinutes', 'day', 'actualMinutes', 'note',
  ])
  return {
    localId: string(row.localId, `${path}.localId`, true),
    sourceTaskId: row.sourceTaskId === null ? null : string(row.sourceTaskId, `${path}.sourceTaskId`, true),
    title: string(row.title, `${path}.title`),
    priority: oneOf(row.priority, `${path}.priority`, ['P0', 'P1', 'P2']),
    seq: integer(row.seq, `${path}.seq`),
    completion: completion(row.completion, `${path}.completion`),
    estMinutes: nullableInteger(row.estMinutes, `${path}.estMinutes`),
    day: nullableDay(row.day, `${path}.day`),
    actualMinutes: nullableInteger(row.actualMinutes, `${path}.actualMinutes`),
    note: nullableString(row.note, `${path}.note`),
  }
}

function proposalPhase(value: unknown, path: string): ProposalPhaseSnapshot {
  const row = object(value, path)
  exact(row, path, ['localId', 'sourcePhaseId', 'title', 'acceptanceCriteria', 'seq', 'completion', 'tasks'])
  return {
    localId: string(row.localId, `${path}.localId`, true),
    sourcePhaseId: row.sourcePhaseId === null ? null : string(row.sourcePhaseId, `${path}.sourcePhaseId`, true),
    title: string(row.title, `${path}.title`),
    acceptanceCriteria: string(row.acceptanceCriteria, `${path}.acceptanceCriteria`),
    seq: integer(row.seq, `${path}.seq`),
    completion: completion(row.completion, `${path}.completion`),
    tasks: array(row.tasks, `${path}.tasks`, proposalTask),
  }
}

function proposalSnapshot(value: unknown): ProposalSnapshotV1 {
  const row = object(value, 'candidate')
  exact(row, 'candidate', ['schemaVersion', 'phases'])
  if (row.schemaVersion !== 1) throw new TypeError('candidate.schemaVersion 必须为 1')
  return { schemaVersion: 1, phases: array(row.phases, 'candidate.phases', proposalPhase) }
}

function validationIssue(value: unknown, path: string): ProposalValidationIssue {
  const row = object(value, path)
  exact(row, path, ['code', 'message'], ['phaseLocalId', 'taskLocalId', 'day'])
  return {
    code: string(row.code, `${path}.code`, true),
    message: string(row.message, `${path}.message`),
    ...(row.phaseLocalId === undefined ? {} : { phaseLocalId: string(row.phaseLocalId, `${path}.phaseLocalId`, true) }),
    ...(row.taskLocalId === undefined ? {} : { taskLocalId: string(row.taskLocalId, `${path}.taskLocalId`, true) }),
    ...(row.day === undefined ? {} : { day: day(row.day, `${path}.day`) }),
  }
}

function orderingConstraint(value: unknown, path: string): OrderingConstraint {
  const row = object(value, path)
  exact(row, path, ['predecessorTaskLocalId', 'successorTaskLocalId', 'strength', 'reason'])
  return {
    predecessorTaskLocalId: string(row.predecessorTaskLocalId, `${path}.predecessorTaskLocalId`, true),
    successorTaskLocalId: string(row.successorTaskLocalId, `${path}.successorTaskLocalId`, true),
    strength: oneOf(row.strength, `${path}.strength`, ['required', 'preferred']),
    reason: string(row.reason, `${path}.reason`),
  }
}

function capacityDay(value: unknown, path: string): CapacityValidationDay {
  const row = object(value, path)
  exact(row, path, ['day', 'limitMinutes', 'externalPlannedMinutes', 'candidatePlannedMinutes'])
  return {
    day: day(row.day, `${path}.day`),
    limitMinutes: integer(row.limitMinutes, `${path}.limitMinutes`),
    externalPlannedMinutes: integer(row.externalPlannedMinutes, `${path}.externalPlannedMinutes`),
    candidatePlannedMinutes: integer(row.candidatePlannedMinutes, `${path}.candidatePlannedMinutes`),
  }
}

function proposalValidation(value: unknown): ProposalValidationV1 {
  const row = object(value, 'validation')
  if (row.schemaVersion !== 1) throw new TypeError('validation.schemaVersion 必须为 1')
  if (row.state === 'pending') {
    exact(row, 'validation', ['schemaVersion', 'state'])
    return { schemaVersion: 1, state: 'pending' }
  }
  if (row.state !== 'evaluated') throw new TypeError('validation.state 枚举值非法')
  const stage = oneOf(row.checkedStage, 'validation.checkedStage', ['structure', 'estimate', 'schedule'])
  const common = ['schemaVersion', 'state', 'validatedRevision', 'checkedStage', 'verdict', 'issues']
  const validatedRevision = integer(row.validatedRevision, 'validation.validatedRevision')
  const verdict = oneOf(row.verdict, 'validation.verdict', ['valid', 'invalid'])
  const issues = array(row.issues, 'validation.issues', validationIssue)
  if (stage !== 'schedule') {
    exact(row, 'validation', common)
    return { schemaVersion: 1, state: 'evaluated', validatedRevision, checkedStage: stage, verdict, issues }
  }
  exact(row, 'validation', [...common, 'orderingConstraints', 'capacityDays', 'scheduleVersion'])
  return {
    schemaVersion: 1,
    state: 'evaluated',
    validatedRevision,
    checkedStage: 'schedule',
    verdict,
    issues,
    orderingConstraints: array(row.orderingConstraints, 'validation.orderingConstraints', orderingConstraint),
    capacityDays: array(row.capacityDays, 'validation.capacityDays', capacityDay),
    scheduleVersion: integer(row.scheduleVersion, 'validation.scheduleVersion'),
  }
}

function decode<T>(raw: string, proposalId: string, column: ProposalJsonColumn, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(raw) as unknown)
  } catch (cause) {
    throw new ProposalDataCorruptError(proposalId, column, cause)
  }
}

export function encodePlanSnapshot(value: PlanSnapshotV1): string { return JSON.stringify(value) }
export function encodeProposalSnapshot(value: ProposalSnapshotV1): string { return JSON.stringify(value) }
export function encodeProposalValidation(value: ProposalValidationV1): string { return JSON.stringify(value) }

export function decodePlanSnapshot(raw: string, proposalId: string): PlanSnapshotV1 {
  return decode(raw, proposalId, 'baseline_json', planSnapshot)
}

export function decodeProposalSnapshot(raw: string, proposalId: string): ProposalSnapshotV1 {
  return decode(raw, proposalId, 'candidate_json', proposalSnapshot)
}

export function decodeProposalValidation(raw: string, proposalId: string): ProposalValidationV1 {
  return decode(raw, proposalId, 'validation_json', proposalValidation)
}
