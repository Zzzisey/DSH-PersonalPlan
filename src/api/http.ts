/**
 * 路由层唯一的请求围栏与响应工具。
 *
 * 所有 `/personal-planner/*` 接口都必须经过这里：只接受回环请求，
 * 响应统一带 `no-store` / `nosniff` / `no-referrer`。
 * @module @local/planner/api/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 只接受本机发起的请求，挡住 DNS rebinding 与跨站表单提交。
 * @param req - Node 入站请求。
 * @returns 是否放行。
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined || !LOOPBACK_ADDRESSES.has(address)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let url: URL
  try {
    url = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!LOOPBACK_NAMES.has(url.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === url.host
  } catch {
    return false
  }
}

/** 所有接口共用的响应头；要加安全头只改这里。 */
function responseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

/**
 * 写一个 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可序列化的响应体，约定 `{ ok: true, ... }` 或 `{ ok: false, error }`。
 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, responseHeaders())
  res.end(JSON.stringify(body))
}

/**
 * 读取 JSON 请求体，带体积上限。
 * @param req - Node 入站请求。
 * @param maxBytes - 允许的最大字节数，默认 64 KiB。
 * @returns 解析后的对象；非法 JSON 或超限返回 undefined。
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
