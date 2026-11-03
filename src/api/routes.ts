/**
 * 面板接口：月网格、某日清单、改任务、改容量。
 *
 * 约定（见 docs/client-design.md §4）：全部同源、只接受回环请求；成功 `{ ok: true, ... }`，
 * 失败 `{ ok: false, error }`；任务形状对客户端只暴露它会用到的字段。
 * @module @local/planner/api/routes
 */
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { getCapacity, listGoals, listTasks, setCapacity, updateTasks } from '../db/repo.js'
import { capacityBetween, checkCapacity, limitFor, monthGrid, todayInShanghai } from '../planning.js'
import type { CapacityRules, Task, TaskStatus } from '../types.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.js'

const ROUTE = '/personal-planner'
const VERSION = '0.1.0'
const MAX_UPDATES = 20
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'dropped']

/** 客户端需要的任务字段；内部的 note / phaseId 等不外发。 */
interface PublicTask {
  id: string
  title: string
  day: string | null
  estMinutes: number
  priority: string
  status: TaskStatus
  goalId: string | null
}

function publicTask(task: Task): PublicTask {
  return {
    id: task.id,
    title: task.title,
    day: task.day,
    estMinutes: task.estMinutes,
    priority: task.priority,
    status: task.status,
    goalId: task.goalId,
  }
}

function ping(): { ok: boolean; version: string; at: string } {
  return { ok: true, version: VERSION, at: new Date().toISOString() }
}

function monthOf(url: URL): string {
  const raw = url.searchParams.get('month')
  return raw !== null && MONTH_RE.test(raw) ? raw : todayInShanghai().slice(0, 7)
}

function dayOf(url: URL): string | undefined {
  const raw = url.searchParams.get('day')
  return raw !== null && DATE_RE.test(raw) ? raw : undefined
}

/** 月网格 + 目标进度 + 当前容量。 */
function monthPayload(db: DatabaseSync, month: string): unknown {
  const grid = monthGrid(month)
  const capacity = getCapacity(db)
  const from = grid[0]!
  const to = grid[grid.length - 1]!
  const tasks = listTasks(db, { from, to, limit: 200 })

  const byDay = new Map<string, { planned: number; count: number }>()
  for (const task of tasks) {
    if (task.day === null) continue
    const entry = byDay.get(task.day) ?? { planned: 0, count: 0 }
    entry.count += 1
    if (task.status !== 'done' && task.status !== 'dropped') entry.planned += task.estMinutes
    byDay.set(task.day, entry)
  }

  const days = grid.map((day) => {
    const entry = byDay.get(day)
    return {
      day,
      planned: entry?.planned ?? 0,
      limit: limitFor(day, capacity),
      count: entry?.count ?? 0,
      inMonth: day.slice(0, 7) === month,
    }
  })

  const today = todayInShanghai()
  const goals = listGoals(db, 'active').map((goal) => {
    const mine = listTasks(db, { goalId: goal.id, limit: 200 })
    const done = mine.filter((task) => task.status === 'done').length
    const total = mine.length
    const remaining = mine
      .filter((task) => task.status !== 'done' && task.status !== 'dropped')
      .reduce((sum, task) => sum + task.estMinutes, 0)
    const deadline = goal.deadline
    let atRisk = false
    if (deadline !== null) {
      const usable = deadline < today ? 0 : capacityBetween(today, deadline, capacity)
      atRisk = remaining > usable
    }
    return {
      id: goal.id,
      title: goal.title,
      deadline,
      done,
      total,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
      atRisk,
    }
  })

  // 未排期任务单独列出来：它们不在任何一天里，日历上看不到，但也不能就这样消失。
  const unscheduled = listTasks(db, { limit: 200 })
    .filter((task) => task.day === null && task.status !== 'done' && task.status !== 'dropped')
    .map(publicTask)

  return { ok: true, month, today, days, goals, capacity, unscheduled }
}

/** 某一天的任务清单 + 当日负载。 */
function dayPayload(db: DatabaseSync, day: string): unknown {
  const capacity = getCapacity(db)
  const tasks = listTasks(db, { from: day, to: day, limit: 200 })
  const planned = tasks
    .filter((task) => task.status !== 'done' && task.status !== 'dropped')
    .reduce((sum, task) => sum + task.estMinutes, 0)
  return {
    ok: true,
    day,
    planned,
    limit: limitFor(day, capacity),
    tasks: tasks.map(publicTask),
  }
}

/** 受影响日期的容量报告；没有日期则返回 undefined。 */
function reportFor(db: DatabaseSync, days: string[]): unknown {
  const sorted = [...new Set(days)].sort()
  if (sorted.length === 0) return undefined
  const from = sorted[0]!
  const to = sorted[sorted.length - 1]!
  const tasks = listTasks(db, { from, to, limit: 200 })
    .filter((task) => task.day !== null && sorted.includes(task.day))
  return checkCapacity(
    tasks.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
    getCapacity(db),
  )
}

async function patchTasks(db: DatabaseSync, req: Parameters<WebRoute['handler']>[0], res: Parameters<WebRoute['handler']>[1]): Promise<void> {
  const body = await readJsonBody(req)
  if (!Array.isArray(body)) {
    writeJson(res, 400, { ok: false, error: 'expected a JSON array' })
    return
  }
  if (body.length === 0 || body.length > MAX_UPDATES) {
    writeJson(res, 400, { ok: false, error: `一次最多 ${MAX_UPDATES} 条` })
    return
  }

  const patches: Parameters<typeof updateTasks>[1] = []
  for (const [index, raw] of body.entries()) {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined
    if (id === undefined) {
      writeJson(res, 400, { ok: false, error: `第 ${index + 1} 条缺少 id` })
      return
    }
    const status = item.status
    if (status !== undefined && !STATUSES.includes(status as TaskStatus)) {
      writeJson(res, 400, { ok: false, error: `第 ${index + 1} 条状态非法` })
      return
    }
    const day = item.day
    if (day !== undefined && (typeof day !== 'string' || !DATE_RE.test(day))) {
      writeJson(res, 400, { ok: false, error: `第 ${index + 1} 条日期必须是 YYYY-MM-DD` })
      return
    }
    patches.push({
      id,
      ...(status === undefined ? {} : { status: status as TaskStatus }),
      ...(day === undefined ? {} : { day: day as string }),
    })
  }

  try {
    const tasks = updateTasks(db, patches)
    const report = reportFor(db, tasks.map((task) => task.day).filter((day): day is string => day !== null))
    writeJson(res, 200, { ok: true, tasks: tasks.map(publicTask), ...(report === undefined ? {} : { report }) })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function putCapacity(db: DatabaseSync, req: Parameters<WebRoute['handler']>[0], res: Parameters<WebRoute['handler']>[1]): Promise<void> {
  const body = await readJsonBody(req)
  if (body === undefined) {
    writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  const weekdayMinutes = body.weekdayMinutes
  const weekendMinutes = body.weekendMinutes
  const overrides = body.overrides
  if (typeof weekdayMinutes !== 'number' || typeof weekendMinutes !== 'number') {
    writeJson(res, 400, { ok: false, error: '需要 weekdayMinutes 与 weekendMinutes（分钟）' })
    return
  }
  if (overrides !== undefined && (typeof overrides !== 'object' || overrides === null)) {
    writeJson(res, 400, { ok: false, error: 'overrides 必须是 { "YYYY-MM-DD": 分钟 } 对象' })
    return
  }
  const rules: CapacityRules = {
    weekdayMinutes,
    weekendMinutes,
    overrides: (overrides ?? {}) as Record<string, number>,
  }
  try {
    setCapacity(db, rules)
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  const today = todayInShanghai()
  const month = today.slice(0, 7)
  const grid = monthGrid(month)
  const tasks = listTasks(db, { from: grid[0]!, to: grid[grid.length - 1]!, limit: 200 })
  const report = checkCapacity(
    tasks.map((task) => ({ title: task.title, day: task.day, estMinutes: task.estMinutes })),
    getCapacity(db),
  )
  writeJson(res, 200, { ok: true, capacity: getCapacity(db), report })
}

/**
 * 构造面板路由。
 * @param db - 已打开的连接。
 * @returns 一条覆盖 `/personal-planner` 前缀的路由。
 */
export function createPlannerRoutes(db: DatabaseSync): WebRoute[] {
  return [{
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      try {
        if (req.method === 'GET' && path === `${ROUTE}/api/ping`) {
          writeJson(res, 200, ping())
          return
        }
        if (req.method === 'GET' && path === `${ROUTE}/api/month`) {
          writeJson(res, 200, monthPayload(db, monthOf(url)))
          return
        }
        if (req.method === 'GET' && path === `${ROUTE}/api/day`) {
          const day = dayOf(url)
          if (day === undefined) {
            writeJson(res, 400, { ok: false, error: '需要 day=YYYY-MM-DD' })
            return
          }
          writeJson(res, 200, dayPayload(db, day))
          return
        }
        if (req.method === 'PATCH' && path === `${ROUTE}/api/tasks`) {
          await patchTasks(db, req, res)
          return
        }
        if (req.method === 'PUT' && path === `${ROUTE}/api/capacity`) {
          await putCapacity(db, req, res)
          return
        }
        writeJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }]
}
