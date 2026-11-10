# Personal Planner V2 开发总结与后续执行路线图

> 记录日期：2026-11-10
>
> 当前开发基线：`codex/refactor/planner-service` @ `0d3a73d`
>
> 用途：总结阶段 0–3 的已完成工作，并把阶段 4–8 拆成可逐个下达、逐个验收的小请求。

## 1. 文档定位

本文是执行清单，不替代以下权威来源：

1. [`NEW_PLANNING_FLOW.md`](./NEW_PLANNING_FLOW.md)：业务流程与业务语义；
2. [`ARCHITECTURE_V2.md`](./ARCHITECTURE_V2.md)：目标架构、模块职责与依赖方向；
3. [`MIGRATION_V2.md`](./MIGRATION_V2.md)：迁移阶段、Schema 演进、切换与回滚顺序。

如本文与上述文档冲突，按职责处理：业务语义以 `NEW_PLANNING_FLOW.md` 为准，模块边界以 `ARCHITECTURE_V2.md` 为准，迁移顺序以 `MIGRATION_V2.md` 为准。跨领域冲突必须先同步修正文档，再开始实现，不在代码中自行选择一种解释。

始终保持以下共识：

- 正式业务层级只有 `Goal → Phase → Task`；
- `PlanProposal` 是唯一规划工作流对象，“草稿”只是未提交性质，不是另一种类型；
- `structure → estimate → schedule → ready` 始终更新同一条 Proposal；
- 当前 DSH Agent 负责生成和语义自检，程序负责确定性校验；
- staged 工具内部不得启动另一套裸 LLM 循环；
- ready 前不得写入正式 Phase/Task；
- ready 后由服务端根据 baseline 与 candidate 计算 Diff；
- 用户在日历最终预览中明确确认后，才允许短事务提交。

## 2. 已完成工作

### 2.1 阶段 0：设计冻结

基线提交：`9b0d321 docs: clarify proposal lifecycle and remove legacy notes`

已完成：

- 建立并校准三份权威设计文档；
- 固定 Goal、Phase、Task 与 PlanProposal 的语义；
- 明确三阶段规划、最终预览、短事务提交和并发原则；
- 明确 legacy 与 staged 渐进迁移顺序；
- 删除过时的 `docs/STATE.md` 与 `docs/backlog.md`，后续不得恢复。

### 2.2 阶段 1：旧行为特征测试

分支：`codex/test/legacy-characterization`

阶段终点：`c7bc6c6`

提交：

| 提交 | 内容 |
|---|---|
| `6169cc1` | 增加 legacy adapter 测试 harness |
| `2311d50` | 锁定 legacy Tool 行为 |
| `8fe8f32` | 锁定 legacy Planner Route 行为 |
| `6ba3f66` | 锁定 legacy Schema 与事务行为 |
| `c7bc6c6` | 补充非回环请求拒绝测试 |

已覆盖：

- Goal 创建与更新；
- legacy propose 的正常、无效、需要决策等路径；
- commit、重复 commit、过期 Draft 和事务回滚；
- 月/日历查询、任务批量更新和容量设置；
- 空库、v1 → v2、字段约束和非回环请求拒绝。

这些测试只用于保护迁移前行为，不表示 V2 要继续采用 legacy Draft 语义。

### 2.3 阶段 2：提取 Core

分支：`codex/refactor/core-boundary`

阶段终点：`880de96`

提交：

| 提交 | 内容 |
|---|---|
| `f3419b8` | 将共享领域类型迁入 Core |
| `4c02969` | 抽离容量与日期确定性校验 |
| `582da5b` | 建立正式 `ValidationIssue`，保留 legacy `Issue` 别名 |
| `00856c3` | 集中规划策略常量 |
| `921c5db` | legacy 调用方改经 Core 使用规则 |
| `880de96` | 增加 Core 依赖边界测试 |

结果：

- `src/core/types.ts` 成为共享类型位置；
- `src/core/policy.ts` 成为稳定规则入口；
- `src/core/validation/capacity.ts` 承载纯容量逻辑；
- Core 不依赖 Cordis、DSH、SQLite、HTTP 或 React；
- 删除旧的 `src/types.ts` 与 `src/planning.ts`；
- legacy 外部行为保持不变。

### 2.4 阶段 3：建立 PlannerService

分支：`codex/refactor/planner-service`

阶段终点：`0d3a73d`

提交：

| 提交 | 内容 |
|---|---|
| `c8983f1` | 建立 `PlannerRepository` 边界与 SQLite Adapter |
| `78ece85` | 建立 `PlannerService`，承接 legacy 业务用例 |
| `17c63e4` | legacy Tools 改经 PlannerService |
| `737c219` | Calendar Routes 改经 PlannerService |
| `8506932` | 将 `src/index.ts` 收敛为装配入口 |
| `0d3a73d` | 增加 Service/Adapter 架构边界测试 |

结果：

- Tool 与 Route 不再直接导入 SQLite Repo；
- PlannerService 可以使用非 SQLite 测试 Repository；
- SQLite、SQL 与事务细节被限制在 Repository 实现中；
- `src/index.ts` 负责 Repository、Service、Tools、Routes 与 Prompt 的装配；
- 旧 Judge/Reschedule 被隔离为 legacy 路径，尚未删除；
- legacy Draft 方法仍是迁移兼容代码，不是 V2 PlanProposal 实现。

阶段三结束时质量门禁：

```text
npm test       58/58 通过
npm run check  通过
npm run build  通过
```

## 3. 后续开发通用规则

每个请求遵循以下规则：

1. 从上一个已验收阶段的最新集成提交创建短分支；
2. 一个请求只解决一个可审查问题，形成一个小提交；
3. Schema、架构移动、业务变化和 legacy 清理不得混在同一提交；
4. 每个请求完成后运行与风险相称的定向测试；
5. 每个阶段结束必须运行完整质量门禁；
6. 未经用户明确要求，不提前执行下一个请求；
7. 不使用真实用户数据库作为自动化测试输入；
8. 涉及真实数据迁移时只操作一致副本，并先验证备份可恢复；
9. 不恢复 `docs/STATE.md` 或 `docs/backlog.md`。

### 3.1 必须避免的实现反模式

| 反模式 | 本项目的强制约束 |
|---|---|
| 吞异常 | 禁止空 `catch` 或捕获后继续返回成功；已知错误映射为稳定错误码，未知错误保留 cause 并向上失败 |
| 伪造默认值 | 查询/解析/迁移失败不能返回 `0`、`[]`、空对象或默认容量；只有已确认“值确实缺省”时才能使用业务默认值 |
| 过度空值检查 | Adapter 一次性解析输入；内部必需字段使用非可空类型，契约损坏显式失败，不用 `?.`、`?? 0`、`?? []` 掩盖 |
| 不必要的兼容分支 | 只支持项目声明的运行时；legacy 只作为阶段性开关，不为未知旧版本增加 fallback |
| 重复校验 | Adapter 校验协议，Core 校验业务，Repository 保证存储；advance 与 commit 复用同一 Validator 实现 |
| 过度重试 | 只重试有上限、可观测且证明幂等的瞬时故障；业务错误、revision 冲突和硬性失败不自动重试 |
| 假成功 | 只有事务提交完成才返回成功；回滚、部分写入、版本冲突和数据库 busy 必须返回失败 |
| 过度验证 | 每个小请求跑与改动相称的定向检查；仅在阶段合并、Schema/并发高风险点或发布门运行完整矩阵 |
| 不必要的兼容设计 | legacy 与 staged 互斥且不双写；旧表只兼容/诊断，不增加新功能，并在阶段 8 进入删除或只读化 |

代码审查时，如果发现以上任一项，不以“测试通过”作为接受理由；应先修正失败语义、责任边界或兼容退出设计。

每个请求的汇报固定包含：

- 分支、提交号与提交信息；
- 修改的文件和边界；
- 用户行为、Schema 是否变化；
- 测试、类型检查和构建结果；
- 已知风险或尚未决定的问题；
- 下一请求的目标，但不自动执行。

推荐下达方式：

```text
执行请求 4.1，完成该请求后停下汇报。
```

阶段性授权方式：

```text
完成阶段 4 的剩余请求，每个请求保持独立提交，整个阶段完成后汇报。
```

## 4. 实现前决策门

### 4.1 阶段 4 前必须确认

1. 容量变化的版本策略：
   - 统一增加 `schedule_version`；或
   - 新增独立 `capacity_version`。
2. `task.seq` 对旧数据采用哪一种稳定回填顺序；
3. 旧 `done` Task/Phase 的 `completed_at` 是否有可靠历史时间；没有可靠来源时不得伪造精确时间。
4. 哪些 Goal 字段会影响 ready Proposal，以及 Goal 更新通过统一版本计数还是 baseline 字段比较使旧 Proposal 失效。
5. Goal/Phase `acceptance_criteria` 的字段契约；
6. 是否允许用户 override 超容量或超过截止日期；若允许，最终 validation verdict 使用 `requires_override` 还是其他结构；
7. PlanSnapshot、ProposalSnapshot、local id、ordering constraints 与 validation JSON 的准确持久化结构。

默认建议是第一版让容量变化统一增加 `schedule_version`，实现更简单且不会让 ready Proposal 在容量变化后继续被静默提交；该建议必须经确认后才能成为实现规则。

阶段 4 决策门只有在结论已经写回对应权威文档后才算完成；口头确认不能直接进入类型、Schema 或 Repository 实现。

### 4.2 阶段 5 前必须确认

以下事项会影响最终 Tool Schema 或 staged 状态机，必须先完成一次独立设计确认：

- 四个场景入口，还是单一 `planner_plan_start(operation)`；
- 阶段和任务数量阈值；
- required 依赖是否允许安排在同一天；
- Proposal 默认过期策略；
- 第一版只由当前 DSH Agent 自检，还是引入独立 Reviewer；
- DSH Agent 最多允许几次语义修订、哪些结构化结果允许再次调用 Tool，以及达到上限后的明确失败结果。

### 4.3 阶段 6 前必须确认

- 月份 Preview API 的准确响应结构；
- Host/GUI 如何获得可信的 Session 身份；客户端不得自行声明 `ownerSessionId`；
- GUI 如何表达 requires-override 或硬性失败；
- 页面刷新后如何恢复当前 Session 的活跃 Proposal；
- “取消并继续修改”与“彻底放弃”的接口语义。

### 4.4 阶段 7 的场景专项决策

- modify 根据哪些字段判定最早回退阶段；
- replan 如何匹配并保留仍需要的未完成 Phase；
- completed Phase/Task 的不可变范围；
- 被删除未完成对象的 Candidate 表达方式。

## 5. 阶段 4：兼容 Proposal Storage

建议分支：`codex/feat/proposal-storage`

目标：增量升级到候选 Schema v3，但默认流程仍为 legacy，不切换 Tool。

### 请求 4.1：锁定 v2 迁移输入

建议提交：`test(storage): characterize v2 migration inputs`

工作：

- 补充 v2 Schema fixture 与旧状态样本；
- 锁定正式对象 id、数量、状态和设置读取行为；
- 锁定当前不存在 `plan_proposal`、`planner_meta` 及新增列的事实；
- 为后续迁移测试准备可重复的数据库副本生成器。

验收：只改测试与 fixture，现有实现仍通过全部测试。

### 请求 4.2：隔离 Schema 所有权

建议提交：`refactor(host): isolate schema migration boundary`

工作：

- 将 Schema 打开、版本检测和迁移责任收敛到目标 Host 边界；
- 保持 `user_version = 2` 和全部 DDL 行为不变；
- 更新导入与架构测试，不夹带 v3 Schema。

验收：纯移动/接线提交，外部行为和数据库字节语义不变。

### 请求 4.3：先定义 Proposal 类型与持久化契约

建议提交：`feat(core): define staged proposal data contracts`

工作：

- 在 Core 定义 `PlanProposal`、`PlanSnapshot`、`ProposalSnapshot`、阶段/任务 local id、`OrderingConstraint`、`ProposalValidation` 和 JSON 可持久化值类型；
- 明确 `stage`、`status`、`operation` 与 revision 的类型，但本请求不实现状态转换；
- Core 提供不依赖 SQLite 的纯 JSON codec；Host Repository 边界声明 Row 映射责任，Core 不导入 SQLite 类型；
- JSON 列解析失败、必需字段缺失或枚举非法时返回稳定的损坏数据错误；
- 禁止用 `unknown` 长期穿透到 Service，禁止用空 Snapshot、默认 stage/status 或空 validation 兜底。

验收：只增加类型、codec 与单测，不修改 Schema；合法值可无损往返，损坏值明确失败。

### 请求 4.4：增加兼容 Schema v3

建议提交：`feat(storage): add compatible proposal schema`

工作：

- 新增 `plan_proposal` 与 `planner_meta`；
- 新增 owner、goal、status/expiry 索引；
- 为 Goal/Phase/Task 增加已确认的兼容列，并执行已经确认的 `task.seq` 与 `completed_at` 回填策略；
- 初始化版本元数据；
- 只做增量迁移，不删除、重命名或重建旧表；
- 不把旧 `draft` 转换为 `PlanProposal`。

验收：空库、v1、v2 均能升级到 v3，重复打开幂等，旧 id 与数据保持不变；没有可靠完成时间时保留 `null`，不得伪造时间。

### 请求 4.5：增加 Proposal Repository 持久化接口

建议提交：`feat(storage): add proposal repository operations`

工作：

- 使用请求 4.3 已定义的类型与 codec，增加 PlanProposal 的创建、按 id/owner 查询和状态查询；
- 增加 `expectedRevision` 条件更新；
- 增加终态保护所需的条件写入；
- 增加 schedule/capacity 版本读取；
- Repository 返回结构化数据或稳定持久化错误，不返回用户文案。

验收：Repository 单测覆盖成功、owner 不匹配、revision 冲突、记录不存在、终态拒绝和损坏 JSON；不得把失败伪装成空 Proposal。

### 请求 4.6：接入正式计划版本计数

建议提交：`feat(storage): version formal plan mutations`

工作：

- 按已确认策略维护 `schedule_version` 与可选 `capacity_version`；
- 所有改变正式 Phase/Task 内容或排期的成功事务只增加一次版本；
- 对会影响 Proposal 有效性的 Goal 字段，按阶段 4 决策采用统一版本增加或 baseline 冲突检查；
- 事务失败时版本不得增加；
- legacy 默认行为和返回协议保持不变。

验收：覆盖任务批量更新、legacy commit、Goal 有效字段变化、容量变化和事务回滚。

### 请求 4.7：完成 v3 迁移与兼容性测试

建议提交：`test(storage): verify v3 compatibility and rollback floor`

工作：

- 校验 `PRAGMA integrity_check`；
- 比较迁移前后 Goal/Phase/Task 数量与关键 id；
- 验证旧 `doing/dropped` 数据不丢失；
- 验证 `task.seq` 与可靠 `completed_at` 按已确认规则回填且重复迁移不改变结果；
- 验证 legacy 查询结果不变；
- 验证 V2 Proposal 写入不进入正式任务查询和容量占用；
- 记录升级后最低回滚版本必须认识 v3 Schema。

### 阶段 4 完成门禁

- 默认仍为 legacy；
- 没有 staged Tool 暴露；
- Proposal 类型与严格 codec 先于 Schema/Repository 实现，不存在第二套存储专用业务类型；
- v3 是只增不删的兼容迁移；
- `draft/check_log` 完整保留；
- `npm test`、`npm run check`、`npm run build` 全部通过；
- 在一致数据库副本上完成迁移、幂等和恢复演练；
- 经用户确认后再建立 `planner-v2-compat` 兼容标签。

## 6. 阶段 5：新建计划三阶段纵向切片

建议分支：`codex/feat/staged-plan-create`

目标：只实现 create 场景的 `structure → estimate → schedule → ready`，不实现正式预览提交。

### 请求 5.1：冻结 staged 契约决策

建议提交：`docs(planning): freeze staged proposal contracts`

工作：解决第 4.2 节决策，更新三份权威文档中对应的“尚待确定”内容，并记录 Tool 输入输出和错误码。

验收：只改文档，不写生产实现。

### 请求 5.2：实现 Proposal 状态机

建议提交：`feat(core): add proposal state transitions`

工作：

- 复用请求 4.3 已定义的 Proposal、Snapshot、local id 与 validation 类型，不再定义第二套类型；
- 分离 stage 与 status；
- 实现合法推进、终态保护、退回和下游字段失效；
- revision 每次成功修改只增加一次；
- ready 不复制 Proposal。

验收：纯 Core 单测覆盖所有合法与非法转换。

### 请求 5.3：实现结构阶段确定性校验

建议提交：`feat(core): validate proposal structure stage`

工作：检查允许/禁止字段、空 Phase、归属、顺序、数量阈值、local id 和可确定识别的重复项。

验收：结构阶段携带时长或日期必须拒绝，且不能污染已保存 candidate。

### 请求 5.4：实现估时阶段确定性校验

建议提交：`feat(core): validate proposal estimate stage`

工作：检查任务集合身份不变、估时完整、15 分钟刻度、15–120 分钟范围，并区分当前阶段修复和退回 structure。

验收：不得为缺失估时默认补 30 分钟；退回 structure 时估时与后续日期失效。

### 请求 5.5：实现排期与依赖确定性校验

建议提交：`feat(core): validate proposal schedule stage`

工作：

- 校验日期格式、截止日期和候选内部一致性；
- 校验 Agent 提供的结构化 ordering constraints、环和 required 顺序；
- ordering constraints 必须引用稳定 task local id，并写入同一 Proposal 的 validation 元数据；
- 按正式占用加 candidate、减 baseline 移除项计算容量；
- 只验证 Agent 已识别的依赖，不声称代码能发现全部语义依赖。

### 请求 5.6：实现 Proposal Service 用例

建议提交：`feat(host): add create proposal service flow`

工作：

- `startProposal(create)` 创建 baseline 和初始 candidate；
- `getProposal` 校验 Session 所有权并返回裁剪上下文；
- `advanceProposal` 调用 Core 并用 expected revision 保存；
- estimate 稳定后接收并保存 ordering constraints；structure 改变时使旧依赖和下游字段失效，只改日期时复用并重新检查已有依赖；
- `discardProposal` 进入终态；
- ready 前不写正式 Phase/Task。

### 请求 5.7：增加 staged Tool 与互斥配置

建议提交：`feat(tools): expose staged create proposal flow`

工作：

- 增加 `planningFlow: legacy | staged`，默认保持 legacy；
- staged 只暴露 create、advance、get、discard 所需工具；
- legacy 与 staged 工具不得同时对同一 Agent 可见；
- 阶段 5 的 staged 仅用于开发和 Agent Eval，尚未形成 Preview/Commit 闭环，不得成为发布默认值；
- Tool 返回结构化结果与稳定错误码；
- Tool 内不调用 `ctx.llm`。

### 请求 5.8：同步 Prompt 与 Agent Eval

建议提交：`test(ai): evaluate staged create tool flow`

工作：

- Prompt 明确三阶段字段边界和用户只在最终预览确认；
- 验证 Agent 先创建正式 Goal，再开始 Proposal；
- 验证语义自检由当前 DSH Agent 完成；
- 按请求 5.1 冻结的上限验证修订次数；Tool 本身不自动重试，不可恢复结果不得再次调用；
- 记录工具选择、调用次数、Token、耗时、有限修订和失败恢复；
- 验证未经用户确认不会调用正式提交。

### 阶段 5 完成门禁

- create 场景可推进到 ready；
- 同一个 Proposal id 贯穿全部阶段；
- candidate 未进入正式查询或容量占用；
- revision 冲突不会静默覆盖；
- staged 路径没有插件内部裸 LLM；
- staged 仍是开发/Eval 模式，不作为发布默认值；
- reschedule、modify、replan 尚未实现；
- legacy 仍可通过配置立即使用；
- 完整质量门禁通过。

## 7. 阶段 6：服务端 Diff、日历预览与短事务提交

建议分支：`codex/feat/proposal-preview`

目标：让 ready Proposal 完成“预览 → 用户确认 → 原子提交”的完整闭环。

### 请求 6.1：实现 Core Diff

建议提交：`feat(core): diff proposal baseline and candidate`

工作：按正式 id、source id 和 draft-local id 计算 added、removed、unchanged 与属性变化；禁止按标题猜测身份；支持日期范围裁剪和变更摘要。

### 请求 6.2：实现 Preview Service Query

建议提交：`feat(host): query proposal preview`

工作：从同一 PlanProposal 的 baseline/candidate 派生 Diff，计算 candidate 状态下的每日容量，并校验 owner、revision 与 awaiting-confirmation 状态。

### 请求 6.3：增加月份 Preview API

建议提交：`feat(api): expose monthly proposal preview`

工作：只返回当前视口需要的正式未变化任务、added、removed、摘要和新容量；Route 只做协议校验与 HTTP 映射。Session 身份必须来自 Host 提供的可信上下文，不能接受客户端自行声明的 `ownerSessionId`。

### 请求 6.4：建立 Client Proposal Model

建议提交：`feat(client): model active proposal preview`

工作：管理月份、选中日期、Proposal id/revision、正式视图、预览加载、失效和统一刷新；Client 不自行重算 Diff。

### 请求 6.5：渲染日历红绿预览

建议提交：`feat(client): render proposal calendar diff`

工作：

- 新增为护眼绿色，删除为红色；
- 移动与属性修改显示为 removed + added；
- 未变化任务保持默认样式；
- 容量条只显示 candidate 提交后的新值；
- 跨月读取必须一致。

### 请求 6.6：实现 Proposal 动作 API 与 optimistic concurrency commit

建议提交：`feat(host): commit proposal with optimistic concurrency`

先实现确认、继续修改和放弃所需的 Service/Route；客户端按钮此时仍不启用。commit 固定顺序：

```text
事务外预检查 id / owner / revision / ready
  → BEGIN IMMEDIATE
  → 事务内重新检查 owner / revision / status / schedule_version / capacity_version
  → 读取最新版本和受影响正式对象
  → 检查 baseline 是否仍可应用
  → 按最新正式日历重跑确定性校验
  → 原子写入正式 Phase/Task
  → 以 expected revision 条件更新 Proposal = committed，版本 + 1
  → COMMIT
```

事务内禁止 Agent、LLM、用户等待或自动改写用户未预览的 candidate。需要改变 candidate 时标记 stale，并要求重新预览和确认。

### 请求 6.7：接入确认、继续修改与放弃交互

建议提交：`feat(client): add proposal preview actions`

工作：在请求 6.6 的真实 API 可用后再启用按钮。确认必须提交当前 revision；继续修改不写正式数据，并让同一 Proposal 回到受影响阶段；彻底放弃进入 discarded。任何失败都显示明确状态，不得先乐观显示成功。

### 请求 6.8：完成 Preview/Commit 契约与并发测试

建议提交：`test(planning): verify preview commit consistency`

覆盖：

- Preview candidate 与最终写入完全一致；
- 旧 revision 的确认被拒绝；
- 预检查后、事务获得锁前 Proposal revision 变化时，事务内复查或 CAS 必须拒绝提交；
- 一个 Session 不能读取、修改或确认另一个 Session 的 Proposal；
- schedule/capacity 版本变化后的重校验；
- 会影响 Proposal 的 Goal 字段变化后不得提交旧预览；
- 两个 Session 修改同一任务；
- 两个 Session 造成同日容量竞争；
- commit 事务失败完全回滚且版本不增加；
- stale 不静默覆盖；
- ready 前不能提交。

### 阶段 6 完成门禁

- create 场景形成完整可用闭环；
- 预览前和确认前正式计划均不变化；
- GUI 不实现对象匹配或业务 Diff；
- Host API 不信任客户端声明的 Proposal owner；
- 正式提交是短事务；
- owner/revision/status/version 在事务锁内复查，Proposal 状态通过 CAS 更新；
- 并发冲突有稳定结果；
- 完整质量门禁通过。

## 8. 阶段 7：其余三种计划变更场景

建议分支：`codex/feat/plan-change-scenarios`

目标：按 reschedule → modify → replan 顺序扩展，共用同一 Proposal Engine、Validator、Diff 和 Commit。

### 请求 7.1：实现 reschedule Service 语义

建议提交：`feat(planning): add reschedule proposal operation`

只允许改变未完成任务 `day`；阶段、标题、优先级、估时和任务边界必须与 baseline 一致；初始阶段为 schedule。

### 请求 7.2：暴露并评估 reschedule Tool

建议提交：`feat(tools): expose reschedule proposal flow`

覆盖正确选用场景、依赖重校验、跨月移动、容量变化与用户确认。

### 请求 7.3：实现 modify 回退规则

建议提交：`feat(planning): add modify proposal operation`

按最早受影响字段决定：日期 → schedule，估时 → estimate，标题/优先级/增删 Task/Phase → structure；退回时下游数据必须失效。

### 请求 7.4：暴露并评估 modify Tool

建议提交：`feat(tools): expose modify proposal flow`

验证 Tool 不把纯日期修改误送到 modify，并验证旧 revision 与旧预览失效。

### 请求 7.5：实现 replan 保留规则

建议提交：`feat(planning): add replan proposal operation`

保留已完成 Phase/Task，按已确认匹配规则处理仍需要的未完成 Phase，删除不再需要的未完成内容，新计划从 structure 开始。

### 请求 7.6：暴露并评估 replan Tool

建议提交：`feat(tools): expose replan proposal flow`

验证 completed 内容不可丢失、正式 id 不变、Candidate 删除语义正确，并且未确认前不修改正式数据。

### 请求 7.7：完成四场景共用引擎回归测试

建议提交：`test(planning): verify shared proposal engine scenarios`

验收：四种场景只在起点和字段许可上不同，不复制状态机、Diff、提交或容量逻辑；Agent Eval 能稳定选对场景。

### 阶段 7 完成门禁

- 四种业务语义均可独立测试；
- 没有四套 Proposal Engine；
- 每个场景都经过最终预览和用户确认；
- legacy 尚未删除；
- 完整质量门禁通过。

## 9. 阶段 8：默认切换与 legacy 清理

建议分支：`codex/refactor/remove-legacy-flow`

目标：在 staged 被证明稳定后切换默认流程，再独立删除 legacy 代码；首版仍不物理删除旧表。

### 请求 8.1：完成切换前发布验证

建议提交：`test(release): qualify staged planning flow`

工作：

- staged create/preview/commit 与三种变更场景通过 Agent Eval；
- 在真实数据库一致副本上完成迁移和回放；
- legacy/staged 对同一正式计划的查询结果一致；
- 演练配置切回 legacy；
- 演练备份恢复；
- 更新运维检查表。

### 请求 8.2：将 staged 改为默认流程

建议提交：`feat(config): make staged planning the default`

保留 legacy 开关和数据，确保异常时可立即切回。该提交不删除任何 legacy 代码。

### 请求 8.3：稳定周期观察门

这不是可一次性跳过的编码提交。观察期至少记录：

- Tool 选择正确率和失败恢复；
- Proposal revision/stale 冲突；
- Preview 与 commit 一致性；
- 数据库忙、事务失败和回滚；
- Token、耗时和重试分布；
- 是否发生切回 legacy。

只有用户明确确认稳定周期通过后，才能执行后续删除请求。

### 请求 8.4：删除插件内部 legacy LLM 循环

建议提交：`refactor(ai): remove direct judge and reschedule calls`

删除 `makeJudgeChat`、旧 Judge/Reschedule 调用和只为其服务的接线；证明 staged 工具不依赖 `ctx.llm.stream`。

### 请求 8.5：删除 legacy Tool 与 Service 命令

建议提交：`refactor(tools): remove legacy planning flow`

删除 legacy propose/commit 注册、`legacyPropose/legacyCommit` 和相应 legacy payload 类型；同时从受支持配置中删除 `planningFlow: legacy`，启动时发现旧值必须返回明确配置错误和迁移提示。不得静默 fallback 到 staged，也不得同时改 staged 业务行为。

### 请求 8.6：将旧工作流表转为只读兼容数据

建议提交：`refactor(storage): retire legacy workflow writes`

停止新写入 `draft/check_log`，保留读取或诊断能力至少一个发布周期；不得物理删除旧表或历史数据。

### 请求 8.7：同步最终文档和架构门禁

建议提交：`docs: finalize staged planning architecture`

工作：更新工具目录、配置、回滚下限与已知兼容项；增加禁止重新引入 legacy Tool、裸 LLM 和 Adapter 业务逻辑的架构测试。

### 阶段 8 完成门禁

- staged 是唯一业务流程，不再保留无实现的 legacy 配置开关；
- 正式层级仍只有 Goal → Phase → Task；
- PlanProposal 仍是唯一候选工作流对象；
- 插件内部没有另一套规划 LLM；
- legacy Tool 与写路径已删除；
- 旧表和历史数据尚未物理删除；
- 物理清理必须作为未来独立 Schema 迁移重新评审；
- 完整质量门禁通过。

## 10. 全程质量门禁

每个准备合并的请求至少执行相关定向测试。每个阶段结束必须执行：

```powershell
npm test
npm run check
npm run build
```

以下情况禁止合并：

- 编译失败或测试失败的中间提交；
- 同时包含大规模文件移动和业务改写；
- 没有迁移测试的 Schema 变化；
- 没有 Tool Eval 的相似工具扩张；
- legacy 与 staged 工具同时暴露给同一个 Agent；
- ready 前写入正式 Phase/Task；
- commit 事务中调用 Agent/LLM 或自动修改 candidate；
- 使用真实用户数据库作为自动化测试输入；
- 吞异常、伪默认值、假成功或无上限重试；
- 多层重复实现同一业务校验；
- legacy/staged 双写或没有退出条件的兼容分支；
- Proposal JSON 使用 `unknown` 穿透 Service，或解析失败后构造空对象/默认状态继续执行；
- 对低风险局部改动无条件运行无关的完整测试矩阵。

## 11. 下一步

下一开发动作不是直接修改 Schema，而是先完成第 4.1 节的阶段 4 决策门，然后执行“请求 4.1：锁定 v2 迁移输入”。

在用户明确授权前，本路线图本身不启动阶段 4 的代码开发。
