import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { createPlannerRoutes } from '../../src/api/routes.ts'
import { createPlannerRepo } from '../../src/db/repo.ts'
import { PlannerService } from '../../src/host/planner-service.ts'

export interface RouteResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

export interface RouteRequest {
  method?: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  remoteAddress?: string
}

export interface RouteHarness {
  request(input: RouteRequest): Promise<RouteResponse>
  close(): Promise<void>
}

/**
 * 直接驱动 WebRoute handler。测试环境不开放 loopback TCP，因此用真实 Readable 请求体和最小响应对象，
 * 同时保留 isLoopbackRequest 所读取的 method/url/headers/socket.remoteAddress。
 */
export async function createRouteHarness(db: DatabaseSync): Promise<RouteHarness> {
  const route = createPlannerRoutes(new PlannerService(createPlannerRepo(db)))[0]
  if (route === undefined) throw new Error('planner route 未注册')
  return {
    async request(input) {
      const payload = input.body === undefined ? undefined : JSON.stringify(input.body)
      let sent = false
      const req = new Readable({
        read() {
          if (sent) return
          sent = true
          if (payload !== undefined) this.push(Buffer.from(payload))
          this.push(null)
        },
      }) as IncomingMessage
      Object.assign(req, {
        method: input.method ?? 'GET',
        url: input.path,
        headers: {
          host: '127.0.0.1:4173',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...input.headers,
        },
        socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
      })

      let status = 0
      let headers: Record<string, string | string[] | undefined> = {}
      let responseText = ''
      const res = {
        writeHead(code: number, nextHeaders: Record<string, string>) {
          status = code
          headers = { ...nextHeaders }
          return this
        },
        end(chunk?: string | Buffer) {
          responseText = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
          return this
        },
      } as unknown as ServerResponse

      await route.handler(req, res)
      let body: unknown = responseText
      try { body = responseText === '' ? undefined : JSON.parse(responseText) } catch { /* 保留原文 */ }
      return { status, headers, body }
    },
    close() {
      return Promise.resolve()
    },
  }
}
