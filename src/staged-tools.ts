import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ScheduleProposalCommand, StructureProposalCommand } from './core/types.js'
import { PlannerService } from './host/planner-service.js'

const output = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function owner(exec: ToolRunContext): string | undefined {
  return exec.agent?.id === undefined ? undefined : String(exec.agent.id)
}

function error(cause: unknown): Record<string, JsonValue> {
  const code = cause instanceof Error ? cause.message : String(cause)
  return { status: 'error', code }
}

function ref(proposal: { id: string; goalId: string; operation: string; stage: string; status: string; revision: number }) {
  return { id: proposal.id, goalId: proposal.goalId, operation: proposal.operation, stage: proposal.stage, proposalStatus: proposal.status, revision: proposal.revision }
}

function contextFor(proposal: ReturnType<PlannerService['getProposal']>): Record<string, JsonValue> {
  const tasks = proposal.candidate.phases.flatMap((phase) => phase.tasks.map((task) => ({
    phaseLocalId: phase.localId,
    taskLocalId: task.localId,
    title: task.title,
    priority: task.priority,
    estMinutes: task.estMinutes,
    day: task.day,
  })))
  return { proposal: ref(proposal), phases: proposal.candidate.phases.map((phase) => ({ localId: phase.localId, title: phase.title })), tasks }
}

function issueValues(issues: readonly { code: string; message: string; phaseLocalId?: string; taskLocalId?: string; day?: string }[]): JsonValue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    ...(issue.phaseLocalId === undefined ? {} : { phaseLocalId: issue.phaseLocalId }),
    ...(issue.taskLocalId === undefined ? {} : { taskLocalId: issue.taskLocalId }),
    ...(issue.day === undefined ? {} : { day: issue.day }),
  }))
}

export function createStagedPlannerTools(service: PlannerService) {
  const goalCreate = defineTool({
    name: 'planner_goal_create',
    description: '创建 staged 规划使用的正式目标。目标必须是单一可验收结果；创建后再调用 planner_plan_create。',
    parameters: {
      title: { type: 'string', required: true },
      acceptance_criteria: { type: 'string', required: true, description: 'trim 后 1–1000 字' },
      motivation: { type: 'string' },
      deadline: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output,
    async execute(args: Record<string, unknown>) {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      const acceptance = typeof args.acceptance_criteria === 'string' ? args.acceptance_criteria.trim() : ''
      if (title === '' || acceptance.length < 1 || acceptance.length > 1000) return { status: 'error', code: 'GOAL_FIELDS_INVALID' }
      if (args.deadline !== undefined && (typeof args.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.deadline))) return { status: 'error', code: 'DAY_INVALID' }
      const goal = service.createGoal({
        title,
        acceptanceCriteria: acceptance,
        ...(typeof args.motivation === 'string' ? { motivation: args.motivation } : {}),
        ...(typeof args.deadline === 'string' ? { deadline: args.deadline } : {}),
      })
      return { status: 'created', goal: { id: goal.id, title: goal.title, deadline: goal.deadline } }
    },
  })

  const planCreate = defineTool({
    name: 'planner_plan_create',
    description: '为已有且尚未规划的正式目标开始 create Proposal。只建立候选上下文，不写正式 Phase/Task。',
    parameters: { goal_id: { type: 'string', required: true } },
    output,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      const session = owner(exec)
      if (session === undefined) return { status: 'error', code: 'SESSION_REQUIRED' }
      if (typeof args.goal_id !== 'string') return { status: 'error', code: 'GOAL_ID_REQUIRED' }
      try {
        const proposal = service.startCreateProposal(session, args.goal_id)
        return { status: 'started', proposal: ref(proposal), next: '提交 1–8 个阶段及每阶段 1–12 个任务的结构，不带估时和日期' }
      } catch (cause) { return error(cause) }
    },
  })

  const planReschedule = defineTool({
    name: 'planner_plan_reschedule',
    description: '已有计划结构和估时正确、只需调整未完成任务日期时使用。不得借此修改标题、优先级、估时或任务边界。',
    parameters: { goal_id: { type: 'string', required: true } },
    output,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      const session = owner(exec)
      if (session === undefined) return { status: 'error', code: 'SESSION_REQUIRED' }
      if (typeof args.goal_id !== 'string') return { status: 'error', code: 'GOAL_ID_REQUIRED' }
      try {
        const proposal = service.startRescheduleProposal(session, args.goal_id)
        return { status: 'started', ...contextFor(proposal), next: '只提交全部任务日期和重新检查后的 ordering constraints' }
      } catch (cause) { return error(cause) }
    },
  })

  const planModify = defineTool({
    name: 'planner_plan_modify',
    description: '局部修改已有计划。改估时从 estimate 开始；改标题、优先级、任务或阶段边界从 structure 开始。纯日期变化必须使用 planner_plan_reschedule。',
    parameters: { goal_id: { type: 'string', required: true }, affected_stage: { type: 'string', required: true, enum: ['structure', 'estimate'] } },
    output,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      const session = owner(exec)
      if (session === undefined) return { status: 'error', code: 'SESSION_REQUIRED' }
      if (typeof args.goal_id !== 'string' || (args.affected_stage !== 'structure' && args.affected_stage !== 'estimate')) return { status: 'error', code: 'ARGUMENT_INVALID' }
      try {
        const proposal = service.startModifyProposal(session, args.goal_id, args.affected_stage)
        return { status: 'started', ...contextFor(proposal), next: `从 ${args.affected_stage} 阶段提交完整候选` }
      } catch (cause) { return error(cause) }
    },
  })

  const advance = defineTool({
    name: 'planner_proposal_advance',
    description: '提交 Proposal 当前阶段产物。structure 只含结构；estimate 只含 task_local_id/est_minutes；schedule 只含日期和 ordering constraints。',
    parameters: {
      proposal_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
      stage: { type: 'string', required: true, enum: ['structure', 'estimate', 'schedule'] },
      content: { type: 'json', required: true },
    },
    output,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      const session = owner(exec)
      if (session === undefined) return { status: 'error', code: 'SESSION_REQUIRED' }
      if (typeof args.proposal_id !== 'string' || !Number.isInteger(args.expected_revision) || typeof args.content !== 'object' || args.content === null) {
        return { status: 'error', code: 'ARGUMENT_INVALID' }
      }
      const revision = args.expected_revision as number
      const content = args.content as Record<string, unknown>
      try {
        if (args.stage === 'structure') {
          if (!Array.isArray(content.phases)) return { status: 'error', code: 'ARGUMENT_INVALID' }
          const command = content as unknown as StructureProposalCommand
          const result = service.advanceStructure(session, args.proposal_id, revision, command)
          return result.status === 'accepted'
            ? { status: result.status, ...contextFor(result.proposal) }
            : result.status === 'revise_required'
              ? { status: result.status, proposal: ref(result.proposal), issues: issueValues(result.issues) }
              : { status: 'error', code: 'PROPOSAL_STAGE_MISMATCH' }
        }
        if (args.stage === 'estimate') {
          if (!Array.isArray(content.tasks)) return { status: 'error', code: 'ARGUMENT_INVALID' }
          const result = service.advanceEstimate(session, args.proposal_id, revision, {
            tasks: (content.tasks as Array<Record<string, unknown>>).map((task) => ({ taskLocalId: String(task.task_local_id), estMinutes: Number(task.est_minutes) })),
          })
          return result.status === 'accepted'
            ? { status: result.status, ...contextFor(result.proposal) }
            : result.status === 'revise_required'
              ? { status: result.status, proposal: ref(result.proposal), issues: issueValues(result.issues) }
              : { status: 'error', code: 'PROPOSAL_STAGE_MISMATCH' }
        }
        if (args.stage === 'schedule') {
          if (!Array.isArray(content.tasks) || !Array.isArray(content.ordering_constraints)) return { status: 'error', code: 'ARGUMENT_INVALID' }
          const command: ScheduleProposalCommand = {
            tasks: (content.tasks as Array<Record<string, unknown>>).map((task) => ({ taskLocalId: String(task.task_local_id), day: String(task.day) })),
            orderingConstraints: (content.ordering_constraints as Array<Record<string, unknown>>).map((edge) => ({
              predecessorTaskLocalId: String(edge.predecessor_task_local_id),
              successorTaskLocalId: String(edge.successor_task_local_id),
              strength: edge.strength === 'preferred' ? 'preferred' : 'required',
              reason: String(edge.reason ?? ''),
            })),
          }
          const result = service.advanceSchedule(session, args.proposal_id, revision, command)
          return result.status === 'ready_for_preview'
            ? { status: result.status, proposal: ref(result.proposal), previewUrl: `/personal-planner?proposal=${encodeURIComponent(result.proposal.id)}&revision=${result.proposal.revision}&token=${encodeURIComponent(result.previewToken)}` }
            : result.status === 'revise_required'
              ? { status: result.status, proposal: ref(result.proposal), issues: issueValues(result.issues) }
              : { status: 'error', code: 'PROPOSAL_STAGE_MISMATCH' }
        }
        return { status: 'error', code: 'PROPOSAL_STAGE_MISMATCH' }
      } catch (cause) { return error(cause) }
    },
  })

  const get = defineTool({
    name: 'planner_proposal_get',
    description: '恢复当前 Session 的 Proposal 和下一阶段所需有限上下文。',
    parameters: { proposal_id: { type: 'string', required: true } },
    output,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      const session = owner(exec)
      if (session === undefined || typeof args.proposal_id !== 'string') return { status: 'error', code: 'ARGUMENT_INVALID' }
      try {
        const proposal = service.getProposal(session, args.proposal_id)
        return { status: 'ok', ...contextFor(proposal), ...(proposal.stage === 'ready' ? { previewUrl: `/personal-planner?proposal=${encodeURIComponent(proposal.id)}&revision=${proposal.revision}&token=${encodeURIComponent(service.issuePreviewToken(proposal))}` } : {}) }
      } catch (cause) { return error(cause) }
    },
  })

  const discard = defineTool({
    name: 'planner_proposal_discard',
    description: '用户明确彻底放弃 Proposal 时使用。终态不可恢复。',
    parameters: { proposal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true } },
    output,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      const session = owner(exec)
      if (session === undefined || typeof args.proposal_id !== 'string' || !Number.isInteger(args.expected_revision)) return { status: 'error', code: 'ARGUMENT_INVALID' }
      try { return { status: 'discarded', proposal: ref(service.discardProposal(session, args.proposal_id, args.expected_revision as number)) } } catch (cause) { return error(cause) }
    },
  })

  return [goalCreate, planCreate, planReschedule, planModify, advance, get, discard]
}
