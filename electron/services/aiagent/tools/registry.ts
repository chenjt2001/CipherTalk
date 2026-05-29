import { BUILTIN_TOOL_SCHEMAS, executeBuiltinTool } from '../global/builtinTools'
import type { Scope } from '../types'

export type ToolScope = Scope['kind']

export interface ToolContext {
  scope: Scope
  readLimit?: number
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  scopes: ToolScope[]
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}

const GLOBAL_TOOL_SPECS: ToolSpec[] = BUILTIN_TOOL_SCHEMAS.map(tool => ({
  name: tool.function.name,
  description: tool.function.description,
  parameters: tool.function.parameters,
  scopes: ['global'],
  run: (args, ctx) => executeBuiltinTool(tool.function.name, args, { readLimit: ctx.readLimit })
}))

export function listToolsForScope(scope: Scope): ToolSpec[] {
  return GLOBAL_TOOL_SPECS.filter(tool => tool.scopes.includes(scope.kind))
}
