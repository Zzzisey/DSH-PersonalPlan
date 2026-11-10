import type { Context } from '@deepseek-ai/cordis'
import type { JudgeChat } from '../judge.js'
import type { JudgeConfig } from './config.js'

/** legacy 兼容路径专用；staged flow 不得调用插件内部裸 LLM。 */
export function makeLegacyJudgeChat(ctx: Context, judge: JudgeConfig): JudgeChat | undefined {
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
    let finish = ''
    for await (const chunk of chunks) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text
        continue
      }
      if (chunk.type === 'finish') finish = String(chunk.reason ?? 'unknown')
    }
    if (text.trim() === '') throw new Error(`模型未返回文本（finish=${finish === '' ? 'none' : finish}）`)
    return text
  }
}
