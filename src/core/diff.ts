import type { PlanSnapshotV1, ProposalSnapshotV1 } from './types.js'

export interface PlanDiffTask {
  key: string
  sourceTaskId: string | null
  title: string
  day: string | null
  estMinutes: number
  priority: string
}

export interface PlanDiff {
  added: PlanDiffTask[]
  removed: PlanDiffTask[]
  unchanged: PlanDiffTask[]
  summary: { added: number; removed: number; changed: number }
}

function sameTask(left: PlanDiffTask, right: PlanDiffTask): boolean {
  return left.title === right.title && left.day === right.day && left.estMinutes === right.estMinutes && left.priority === right.priority
}

export function diffPlan(baseline: PlanSnapshotV1, candidate: ProposalSnapshotV1): PlanDiff {
  const before = baseline.phases.flatMap((phase) => phase.tasks.map((task) => ({
    key: task.id, sourceTaskId: task.id, title: task.title, day: task.day, estMinutes: task.estMinutes, priority: task.priority,
  })))
  const after = candidate.phases.flatMap((phase) => phase.tasks.map((task) => {
    if (task.estMinutes === null) throw new Error('PROPOSAL_NOT_READY')
    return { key: task.localId, sourceTaskId: task.sourceTaskId, title: task.title, day: task.day, estMinutes: task.estMinutes, priority: task.priority }
  }))
  const beforeById = new Map(before.map((task) => [task.sourceTaskId!, task]))
  const matched = new Set<string>()
  const added: PlanDiffTask[] = []
  const removed: PlanDiffTask[] = []
  const unchanged: PlanDiffTask[] = []
  let changed = 0
  for (const task of after) {
    const previous = task.sourceTaskId === null ? undefined : beforeById.get(task.sourceTaskId)
    if (previous === undefined) added.push(task)
    else {
      matched.add(previous.sourceTaskId!)
      if (sameTask(previous, task)) unchanged.push(task)
      else { removed.push(previous); added.push(task); changed += 1 }
    }
  }
  for (const task of before) if (!matched.has(task.sourceTaskId!)) removed.push(task)
  return { added, removed, unchanged, summary: { added: added.length - changed, removed: removed.length - changed, changed } }
}

export function cropDiff(diff: PlanDiff, from: string, to: string): PlanDiff {
  const visible = (task: PlanDiffTask) => task.day !== null && task.day >= from && task.day <= to
  return { ...diff, added: diff.added.filter(visible), removed: diff.removed.filter(visible), unchanged: diff.unchanged.filter(visible) }
}
