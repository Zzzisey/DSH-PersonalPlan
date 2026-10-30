/**
 * Personal Planner · Host 半区入口。
 *
 * 装配顺序：开库 → 注册工具 → 挂路由 → 登记释放。
 * 库打不开时**不抛错**：DSH 会因此起不来；改为降级空转，并用 systemPrompt 告知用户怎么修。
 * @module @local/planner
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPlannerRoutes } from './api/routes.js'
import { openPlannerDb, SchemaTooNewError } from './db/schema.js'
import { createPlannerTools } from './tools.js'
import type { JudgeChat } from './judge.js'

const VERSION = '0.1.0'
const PROMPT_BLOCK = 'plugin:planner'
const PROMPT_ORDER = 155

export const name = 'planner'

/**
 * 必需依赖。`systemPrompt` 用于降级告警——库坏了也要让用户在对话里看到原因。
 * 可选能力（将来如 `skills`）一律用 ctx.get 软探测，绝不写进这里。
 */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** 语义评审配置；不配就等于关闭 Judge，只跑容量校验。 */
export interface JudgeConfig {
  /** 模型 provider，例如 `deepseek-official`。 */
  provider: string
  /** 模型 id。 */
  model: string
  /** 超时毫秒，默认 8000。 */
  timeoutMs?: number
  /** 最多保留多少条评审问题，默认 12。 */
  maxIssues?: number
}

/** 插件配置。配置文件只放部署常量；容量等运行期偏好在数据库里。 */
export interface Config {
  /** SQLite 路径；留空用 `~/.dsh/personal-planner/planner.sqlite`。 */
  dbPath?: string
  /** 语义评审（可选）。缺省时 propose 只做容量校验。 */
  judge?: JudgeConfig
}

/**
 * 用 `ctx.llm.stream` 组装评审用的 chat 函数。
 *
 * 软探测：宿主没有 `llm` 服务时返回 undefined（评审关闭），绝不写进 inject——
 * 那会让整个插件在缺 `llm` 的宿主上 pending。
 * @param ctx - 插件上下文。
 * @param judge - 评审配置。
 * @returns 可用的 chat 函数，或 undefined。
 */
function makeJudgeChat(ctx: Context, judge: JudgeConfig): JudgeChat | undefined {
  const llm = (ctx as unknown as { get?: (name: string) => unknown }).get?.('llm') as
    | { stream?: (options: Record<string, unknown>) => AsyncIterable<Record<string, unknown>> }
    | undefined
  if (llm === undefined || typeof llm.stream !== 'function') return undefined
  const stream = llm.stream.bind(llm)
  return async (system, user, signal) => {
    let text = ''
    const chunks = stream({
      provider: judge.provider,
      model: judge.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      signal,
    })
    for await (const chunk of chunks) {
      if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'text-delta') continue
      if (typeof chunk.text === 'string') text += chunk.text
      else if (typeof chunk.delta === 'string') text += chunk.delta
    }
    return text
  }
}

/** ping 的响应体；Client 徽章也读同一份。 */
function ping(): { ok: boolean; version: string; at: string } {
  return { ok: true, version: VERSION, at: new Date().toISOString() }
}

/**
 * 数据库不可用时的空转分支：不注册工具与数据路由，只留一条提示让模型转告用户。
 * @param ctx - 插件上下文。
 * @param error - 打开数据库时的错误。
 */
function applyDegraded(ctx: Context, error: unknown): void {
  const detail = error instanceof SchemaTooNewError
    ? `数据库 schema 版本 ${error.dbVersion} 比当前插件支持的 ${error.supportedVersion} 新`
    : `无法打开数据库：${error instanceof Error ? error.message : String(error)}`
  const notice = `[planner] 已降级空转：${detail}。插件已加载但未注册任何工具或路由。`
  console.error(notice)
  ctx.effect(() => ctx.systemPrompt.section({
    name: PROMPT_BLOCK,
    order: PROMPT_ORDER,
    text: `个人计划插件当前不可用（已降级空转）。原因：${detail}。`
      + '请告知用户：升级插件到与数据库匹配的版本，或修好数据库路径后重启 DSH；不要调用任何 planner_* 工具（它们没有注册）。',
  }), 'planner: degraded prompt')
}

/**
 * 装配插件。
 * @param ctx - 插件上下文；依赖由 inject 保证。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let db: DatabaseSync
  try {
    db = openPlannerDb(config)
  } catch (error) {
    applyDegraded(ctx, error)
    return
  }

  // 先登记关库：cordis 按注册逆序释放，所以它会最后执行，避免工具还在用时连接已关。
  ctx.effect(() => () => { db.close() }, 'planner: db')

  ctx.effect(() => {
    const judge = config.judge
    const judgeChat = judge === undefined ? undefined : makeJudgeChat(ctx, judge)
    if (judge !== undefined && judgeChat === undefined) {
      console.warn('[planner] 配置了 judge 但宿主没有 llm 服务，语义评审已关闭')
    }
    const toolOptions = judgeChat === undefined
      ? {}
      : {
        judgeChat,
        judgeModel: judge === undefined ? '' : `${judge.provider}/${judge.model}`,
        ...(judge?.timeoutMs === undefined ? {} : { judgeTimeoutMs: judge.timeoutMs }),
        ...(judge?.maxIssues === undefined ? {} : { judgeMaxIssues: judge.maxIssues }),
      }
    const disposers = createPlannerTools(db, toolOptions).map((tool) => ctx.tools.register(tool))
    disposers.push(ctx.tools.register(defineTool({
      name: 'planner_ping',
      description: 'Personal Planner 的连通性探针：确认 Host 半区已激活，返回版本与 Host 时钟。不读写任务数据。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
      execute() {
        const current = ping()
        return Promise.resolve(`personal-planner ${current.version} is live · host clock ${current.at}`)
      },
    })))
    return () => { for (const dispose of disposers) dispose() }
  }, 'planner: tools')

  ctx.effect(() => ctx.systemPrompt.section({
    name: PROMPT_BLOCK,
    order: PROMPT_ORDER,
    text: '本机装了个人计划插件（personal-planner）：用户可以让你把长期目标拆成阶段与每日任务、查进度、调整排期。'
      + '规则：计划先 propose 出草稿并做容量校验，用户确认后才能 commit 落库；容量 fail 的计划不允许提交；'
      + '不要声称任务已创建，除非 plan_commit 返回成功。容量规则存在数据库里，不在配置里。',
  }), 'planner: prompt')

  ctx.effect(() => {
    const disposers = createPlannerRoutes(db).map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'planner: routes')
}
