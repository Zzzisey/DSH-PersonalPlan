import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SchemaTooNewError } from '../db/schema.js'

const PROMPT_BLOCK = 'plugin:planner'
const PROMPT_ORDER = 155

export function registerDegradedPrompt(ctx: Context, error: unknown): void {
  const detail = error instanceof SchemaTooNewError
    ? `数据库 schema 版本 ${error.dbVersion} 比当前插件支持的 ${error.supportedVersion} 新`
    : `无法打开数据库：${error instanceof Error ? error.message : String(error)}`
  console.error(`[planner] 已降级空转：${detail}。插件已加载但未注册任何工具或路由。`)
  ctx.effect(() => ctx.systemPrompt.section({
    name: PROMPT_BLOCK,
    order: PROMPT_ORDER,
    text: `个人计划插件当前不可用（已降级空转）。原因：${detail}。`
      + '请告知用户：升级插件到与数据库匹配的版本，或修好数据库路径后重启 DSH；不要调用任何 planner_* 工具（它们没有注册）。',
  }), 'planner: degraded prompt')
}

export function registerLegacyPlannerPrompt(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PROMPT_BLOCK,
    order: PROMPT_ORDER,
    text: '本机装了个人计划插件（personal-planner）：用户可以让你把长期目标拆成阶段与每日任务、查进度、调整排期。'
      + '规则：计划先 propose 出草稿并做容量校验，用户确认后才能 commit 落库；容量 fail 的计划不允许提交；'
      + '不要声称任务已创建，除非 plan_commit 返回成功。容量规则存在数据库里，不在配置里。',
  }), 'planner: prompt')
}
