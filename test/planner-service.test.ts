import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Goal, Task } from '../src/core/types.ts'
import { PlannerService } from '../src/host/planner-service.ts'
import type { PlannerRepository } from '../src/host/repository.ts'

test('PlannerService 可使用不依赖 SQLite 的测试 Repository', () => {
  const goals = new Map<string, Goal>()
  const tasks: Task[] = [{
    id: 't_fake', goalId: 'g_fake', phaseId: null, title: '测试任务', day: '2026-11-10',
    estMinutes: 60, actualMinutes: null, priority: 'P2', status: 'todo', note: null,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  }]
  const repo = {
    createGoal(input: { title: string; motivation?: string; deadline?: string }) {
      const goal: Goal = {
        id: 'g_fake', title: input.title, motivation: input.motivation ?? null,
        deadline: input.deadline ?? null, status: 'active',
        createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
      }
      goals.set(goal.id, goal)
      return goal
    },
    getGoal(id: string) { return goals.get(id) },
    updateGoal(id: string, patch: Partial<Goal>) {
      const current = goals.get(id)
      if (current === undefined) return undefined
      const updated = { ...current, ...patch }
      goals.set(id, updated)
      return updated
    },
    listTasks() { return tasks },
    getCapacity() { return { weekdayMinutes: 240, weekendMinutes: 120, overrides: {} } },
  } as unknown as PlannerRepository

  const service = new PlannerService(repo)
  const goal = service.createGoal({ title: '测试目标' })
  assert.equal(goal.id, 'g_fake')
  assert.equal(service.updateGoal(goal.id, { status: 'done' })?.status, 'done')
  assert.deepEqual(service.queryCalendarDay('2026-11-10'), {
    day: '2026-11-10', planned: 60, limit: 240, tasks,
  })
})
