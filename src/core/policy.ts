/** 当前 legacy 行为使用的稳定规划常量；阶段二只移动来源，不改变数值。 */

/** 单任务粒度上限（分钟）；超过就建议再拆。 */
export const MAX_TASK_MINUTES = 120

/** 单日物理上限（分钟）；超过视为数据错误，而不是权衡。 */
export const MAX_DAY_MINUTES = 720

/** 接近上限的告警线：`load >= 0.85` 即 warn。 */
export const CAPACITY_WARN_RATIO = 0.85

export const MIN_PROPOSAL_PHASES = 1
export const MAX_PROPOSAL_PHASES = 8
export const MIN_PHASE_TASKS = 1
export const MAX_PHASE_TASKS = 12
export const ESTIMATE_STEP_MINUTES = 15
export const MIN_ESTIMATE_MINUTES = 15
export const MAX_ESTIMATE_MINUTES = 120
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_STAGE_REVISIONS = 2
