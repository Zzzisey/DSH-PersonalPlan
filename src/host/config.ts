/** 语义评审配置；不配就等于关闭 legacy Judge，只跑容量校验。 */
export interface JudgeConfig {
  provider: string
  model: string
  timeoutMs?: number
  maxIssues?: number
}

/** 插件部署配置；容量等运行期偏好仍保存在数据库。 */
export interface Config {
  dbPath?: string
  judge?: JudgeConfig
}
