/**
 * 面板接口：月网格、某日清单、改任务、改容量。
 *
 * 约定（见 docs/client-design.md §4）：全部同源、只接受回环请求；成功 `{ ok: true, ... }`，
 * 失败 `{ ok: false, error }`；任务形状对客户端只暴露它会用到的字段。
 * @module @local/planner/api/routes
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { todayInShanghai } from '../core/validation/capacity.js'
import type { CapacityRules, Task, TaskStatus } from '../core/types.js'
import { PlannerService } from '../host/planner-service.js'
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

function proposalQuery(url: URL): { proposalId: string; token: string; revision: number } | undefined {
  const proposalId = url.searchParams.get('proposal')
  const token = url.searchParams.get('token')
  const revision = Number(url.searchParams.get('revision'))
  return proposalId === null || proposalId === '' || token === null || token === '' || !Number.isInteger(revision) || revision < 0
    ? undefined
    : { proposalId, token, revision }
}

async function proposalAction(service: PlannerService, action: 'commit' | 'continue' | 'discard', req: Parameters<WebRoute['handler']>[0], res: Parameters<WebRoute['handler']>[1]): Promise<void> {
  const body = await readJsonBody(req)
  const proposalId = body?.proposalId
  const token = body?.token
  const revision = body?.revision
  if (typeof proposalId !== 'string' || typeof token !== 'string' || !Number.isInteger(revision)) {
    writeJson(res, 400, { ok: false, error: 'proposalId、token、revision 必填' })
    return
  }
  try {
    const owner = service.ownerFromPreviewToken(token, proposalId)
    if (action === 'commit') writeJson(res, 200, { ok: true, result: service.commitProposal(token, proposalId, revision as number) })
    else if (action === 'continue') writeJson(res, 200, { ok: true, proposal: service.continueProposal(owner, proposalId, revision as number) })
    else writeJson(res, 200, { ok: true, proposal: service.discardProposal(owner, proposalId, revision as number) })
  } catch (error) {
    writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** 月网格 + 目标进度 + 当前容量。 */
function monthPayload(service: PlannerService, month: string): unknown {
  const view = service.queryCalendarMonth(month)
  return { ...view, ok: true, unscheduled: view.unscheduled.map(publicTask) }
}

/** 某一天的任务清单 + 当日负载。 */
function dayPayload(service: PlannerService, day: string): unknown {
  const view = service.queryCalendarDay(day)
  return { ...view, ok: true, tasks: view.tasks.map(publicTask) }
}

async function patchTasks(service: PlannerService, req: Parameters<WebRoute['handler']>[0], res: Parameters<WebRoute['handler']>[1]): Promise<void> {
  const body = await readJsonBody(req)
  if (!Array.isArray(body)) {
    writeJson(res, 400, { ok: false, error: 'expected a JSON array' })
    return
  }
  if (body.length === 0 || body.length > MAX_UPDATES) {
    writeJson(res, 400, { ok: false, error: `一次最多 ${MAX_UPDATES} 条` })
    return
  }

  const patches: Parameters<PlannerService['updateTasks']>[0] = []
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
    const result = service.updateTasks(patches)
    writeJson(res, 200, { ok: true, tasks: result.tasks.map(publicTask), ...(result.report === undefined ? {} : { report: result.report }) })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function putCapacity(service: PlannerService, req: Parameters<WebRoute['handler']>[0], res: Parameters<WebRoute['handler']>[1]): Promise<void> {
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
    const result = service.updateCapacity(rules)
    writeJson(res, 200, { ok: true, ...result })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 构造面板路由。
 * @param service - 唯一业务入口。
 * @returns 一条覆盖 `/personal-planner` 前缀的路由。
 */
export function createPlannerRoutes(service: PlannerService): WebRoute[] {
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
          writeJson(res, 200, monthPayload(service, monthOf(url)))
          return
        }
        if (req.method === 'GET' && path === `${ROUTE}/api/day`) {
          const day = dayOf(url)
          if (day === undefined) {
            writeJson(res, 400, { ok: false, error: '需要 day=YYYY-MM-DD' })
            return
          }
          writeJson(res, 200, dayPayload(service, day))
          return
        }
        if (req.method === 'GET' && path === `${ROUTE}/api/proposal/preview`) {
          const query = proposalQuery(url)
          if (query === undefined) {
            writeJson(res, 400, { ok: false, error: 'proposal、token、revision 必填' })
            return
          }
          writeJson(res, 200, { ok: true, ...service.queryProposalPreview(query.token, query.proposalId, query.revision, monthOf(url)) })
          return
        }
        if (req.method === 'POST' && path === `${ROUTE}/api/proposal/commit`) {
          await proposalAction(service, 'commit', req, res)
          return
        }
        if (req.method === 'POST' && path === `${ROUTE}/api/proposal/continue`) {
          await proposalAction(service, 'continue', req, res)
          return
        }
        if (req.method === 'POST' && path === `${ROUTE}/api/proposal/discard`) {
          await proposalAction(service, 'discard', req, res)
          return
        }
        if (req.method === 'PATCH' && path === `${ROUTE}/api/tasks`) {
          await patchTasks(service, req, res)
          return
        }
        if (req.method === 'PUT' && path === `${ROUTE}/api/capacity`) {
          await putCapacity(service, req, res)
          return
        }
        writeJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }]
}
