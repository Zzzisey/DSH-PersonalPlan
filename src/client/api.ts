/**
 * 面板的数据访问层。只有这里碰 fetch。
 * 契约见 docs/client-design.md §4。
 */

export interface PublicTask {
  id: string
  title: string
  day: string | null
  estMinutes: number
  priority: string
  status: string
  goalId: string | null
}

export interface MonthDay {
  day: string
  planned: number
  limit: number
  count: number
  inMonth: boolean
}

export interface GoalSummary {
  id: string
  title: string
  deadline: string | null
  done: number
  total: number
  percent: number
  atRisk: boolean
}

export interface Capacity {
  weekdayMinutes: number
  weekendMinutes: number
  overrides: Record<string, number>
}

export interface MonthData {
  ok: true
  month: string
  today: string
  days: MonthDay[]
  goals: GoalSummary[]
  capacity: Capacity
}

export interface DayData {
  ok: true
  day: string
  planned: number
  limit: number
  tasks: PublicTask[]
}

export interface CapacityReport {
  verdict: string
  issues: Array<{ kind: string; severity: string; message: string; suggestion?: string }>
  days: Array<{ day: string; planned: number; limit: number }>
}

const BASE = '/personal-planner/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init)
  const body = await response.json() as { ok?: boolean; error?: string } & T
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

export function getMonth(month: string): Promise<MonthData> {
  return request<MonthData>(`/month?month=${encodeURIComponent(month)}`)
}

export function getDay(day: string): Promise<DayData> {
  return request<DayData>(`/day?day=${encodeURIComponent(day)}`)
}

export function patchTasks(updates: Array<{ id: string; status?: string; day?: string }>): Promise<{ ok: true; tasks: PublicTask[] }> {
  return request<{ ok: true; tasks: PublicTask[] }>('/tasks', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

export function putCapacity(capacity: Capacity): Promise<{ ok: true; capacity: Capacity; report: CapacityReport }> {
  return request<{ ok: true; capacity: Capacity; report: CapacityReport }>('/capacity', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(capacity),
  })
}
