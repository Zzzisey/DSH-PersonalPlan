/**
 * Personal Planner · Host 半区入口。
 *
 * 装配顺序：开库 → 注册工具 → 挂路由 → 登记释放。
 * 库打不开时**不抛错**：DSH 会因此起不来；改为降级空转，并用 systemPrompt 告知用户怎么修。
 * @module @local/planner
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPlannerRoutes } from './api/routes.js'
import { createPlannerRepo } from './db/repo.js'
import { openPlannerDb } from './db/schema.js'
import { createPlannerTools } from './tools.js'
import type { Config } from './host/config.js'
import { makeLegacyJudgeChat } from './host/legacy-llm.js'
import { PlannerService } from './host/planner-service.js'
import { registerDegradedPrompt, registerLegacyPlannerPrompt } from './host/prompt.js'

const VERSION = '0.1.0'
export const name = 'planner'
export type { Config, JudgeConfig } from './host/config.js'

/**
 * 必需依赖。`systemPrompt` 用于降级告警——库坏了也要让用户在对话里看到原因。
 * 可选能力（将来如 `skills`）一律用 ctx.get 软探测，绝不写进这里。
 */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** ping 的响应体；Client 徽章也读同一份。 */
function ping(): { ok: boolean; version: string; at: string } {
  return { ok: true, version: VERSION, at: new Date().toISOString() }
}

/**
 * 装配插件。
 * @param ctx - 插件上下文；依赖由 inject 保证。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let db: ReturnType<typeof openPlannerDb>
  try {
    db = openPlannerDb(config)
  } catch (error) {
    registerDegradedPrompt(ctx, error)
    return
  }

  // 先登记关库：cordis 按注册逆序释放，所以它会最后执行，避免工具还在用时连接已关。
  ctx.effect(() => () => { db.close() }, 'planner: db')

  const judge = config.judge
  const judgeChat = judge === undefined ? undefined : makeLegacyJudgeChat(ctx, judge)
  if (judge !== undefined && judgeChat === undefined) {
    console.warn('[planner] 配置了 judge 但宿主没有 llm 服务，语义评审已关闭')
  }
  const service = new PlannerService(createPlannerRepo(db), judgeChat === undefined
    ? {}
    : {
      judgeChat,
      // 自动挪动复用同一条模型通道：语义评审与语义挪动是同一类调用。
      rescheduleChat: judgeChat,
      judgeModel: judge === undefined ? '' : `${judge.provider}/${judge.model}`,
      ...(judge?.timeoutMs === undefined ? {} : { judgeTimeoutMs: judge.timeoutMs, rescheduleTimeoutMs: judge.timeoutMs }),
      ...(judge?.maxIssues === undefined ? {} : { judgeMaxIssues: judge.maxIssues }),
    })

  ctx.effect(() => {
    const disposers = createPlannerTools(service).map((tool) => ctx.tools.register(tool))
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

  registerLegacyPlannerPrompt(ctx)

  ctx.effect(() => {
    const disposers = createPlannerRoutes(service).map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'planner: routes')
}
