/** 当前 legacy 行为使用的稳定规划常量；阶段二只移动来源，不改变数值。 */

/** 单任务粒度上限（分钟）；超过就建议再拆。 */
export const MAX_TASK_MINUTES = 120

/** 单日物理上限（分钟）；超过视为数据错误，而不是权衡。 */
export const MAX_DAY_MINUTES = 720

/** 接近上限的告警线：`load >= 0.85` 即 warn。 */
export const CAPACITY_WARN_RATIO = 0.85
