import type { DatabaseSync } from 'node:sqlite'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createPlannerTools, type PlannerToolOptions } from '../../src/tools.ts'

export interface ToolHarness {
  definitions: ToolDefinition[]
  tool(name: string): ToolDefinition
  run(name: string, args: Record<string, unknown>): Promise<unknown>
}

/** 直接调用 defineTool 产物，绕过 ToolRuntime，只用于锁定插件适配器的 legacy 行为。 */
export function createToolHarness(db: DatabaseSync, options: PlannerToolOptions = {}): ToolHarness {
  const definitions = createPlannerTools(db, options)
  const tool = (name: string): ToolDefinition => {
    const found = definitions.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`测试工具不存在：${name}`)
    return found
  }
  return {
    definitions,
    tool,
    async run(name, args) {
      const definition = tool(name)
      const controller = new AbortController()
      const exec = {
        callId: `test:${name}`,
        rootCallId: `test:${name}`,
        name,
        arguments: args,
        signal: controller.signal,
        token: Symbol(`test:${name}`),
        deferContext() {},
        concludeTurn() {},
      } as unknown as ToolRunContext
      return definition.execute(args, exec)
    },
  }
}
