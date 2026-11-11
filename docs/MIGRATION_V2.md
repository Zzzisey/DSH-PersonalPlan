# Personal Planner V2 Migration Plan

> 状态：提案，等待评审。
>
> 目的：在不破坏现有正式计划和本地 SQLite 数据的前提下，把当前耦合实现渐进迁移到 [`ARCHITECTURE_V2.md`](./ARCHITECTURE_V2.md)。

## 1. 迁移原则

1. 不做一次性重写；
2. 先锁定旧行为，再移动架构边界；
3. 先提供兼容 Schema，再启用新流程；
4. Schema 迁移只向前、优先新增，不在首个 V2 版本删除旧表或旧列；
5. legacy 与 staged 流程通过配置互斥启用；
6. 每个阶段合并后仓库必须可运行、可测试；
7. 真实数据库只在副本上演练迁移，确认后再升级；
8. 数据库升级后的回滚目标必须认识新 Schema。

## 2. 当前基线

当前代码和数据基线以源码及数据库迁移代码为准：

- SQLite `user_version = 2`；
- 正式表为 `goal / phase / task`；
- 旧工作流表为 `draft / check_log`；
- Tool、Route 直接访问 Repo；
- `planner_plan_propose` 一次性接收结构、时长和日期；
- Judge 与 Reschedule 通过插件内部 `ctx.llm.stream` 调用；
- Client 不展示 legacy `draft`。

迁移期间必须保护：

- 已完成任务和阶段记录；
- 当前未完成正式任务；
- 容量设置；
- 历史 `draft` 与 `check_log`，即使 V2 不再使用它们；
- 现有正式任务 id，避免 Preview Diff 丢失身份。

## 3. Git 阶段

各阶段使用短分支，合并后下一个分支从最新 `main` 开始。

| 阶段 | 建议分支 | 行为变化 | Schema 变化 |
|---|---|---|---|
| 0 | `docs/architecture-v2` | 无 | 无 |
| 1 | `test/legacy-characterization` | 无 | 无 |
| 2 | `refactor/core-boundary` | 无 | 无 |
| 3 | `refactor/planner-service` | 无 | 无 |
| 4 | `feat/proposal-storage` | 默认仍为 legacy | 增量升级到兼容 Schema |
| 5 | `feat/staged-plan-create` | 可选 staged，新建计划可用 | 无破坏性变化 |
| 6 | `feat/proposal-preview` | staged 支持最终预览与提交 | 视索引需要增量变化 |
| 7 | `feat/plan-change-scenarios` | staged 支持其余三种场景 | 无破坏性变化 |
| 8 | `refactor/remove-legacy-flow` | staged 成为唯一流程 | 首版仍不删旧表 |

每个阶段只解决一个维度：

- `refactor/*` 不改变用户行为；
- `feat/storage` 不同时切换 Tool；
- `feat/staged-*` 不顺便清理 legacy；
- 删除旧代码不与新增功能混合。

## 4. 阶段 0：设计冻结

产物：

- `NEW_PLANNING_FLOW.md`：业务语义与用户流程；
- `ARCHITECTURE_V2.md`：模块边界与依赖方向；
- `MIGRATION_V2.md`：Git、Schema、切换与回滚顺序。

验收：

- 文档明确区分当前事实、已确认设计和待评审决策；
- 不修改生产代码；
- 不修改数据库；
- 所有后续分支都能映射到明确的边界和验收条件。

## 5. 阶段 1：旧行为特征测试

在移动代码前补足测试：

### Tool

- goal create / update；
- legacy propose 正常写入旧 `draft`；
- invalid 拒绝；
- decision 分支；
- commit 原子写入；
- 重复 commit 拒绝；
- 过期 legacy `draft` 拒绝。

### Route

- month / day；
- task patch 成功与整批失败；
- capacity 更新；
- 非回环请求拒绝。

### Database

- 空库创建到 v2；
- v1 升级 v2；
- 真实字段和 CHECK 约束；
- 事务异常回滚。

这些测试描述旧实现，不代表 V2 继续保留旧业务语义。它们用于证明阶段 2、3 只是重构。

## 6. 阶段 2：提取 Core

迁移顺序：

1. 移动公共类型；
2. 移动日期、容量纯函数；
3. 建立结构化 Validation Issue；
4. 让旧 Tools 与 Routes 继续调用新位置；
5. 不改变 Tool 名、参数、返回或数据库。

验收：

- 旧特征测试全部通过；
- Core 不导入 DSH、Cordis、SQLite、HTTP、React；
- 每个移动提交都能独立 build；
- 不出现“移动文件同时重写逻辑”的提交。

## 7. 阶段 3：建立 PlannerService

先用 Service 包住旧逻辑，再迁移入口：

```text
旧 Tool → PlannerService legacy command → 阶段三 Repository
旧 Route → PlannerService query/command → 阶段三 Repository
```

推荐顺序：

1. goal commands；
2. calendar queries；
3. task updates；
4. legacy propose；
5. legacy commit。

每迁移一个入口就删除该入口中的直接 Repo 调用。全部完成后，Tools 和 Routes 不应再 import SQLite Repo 函数。

验收：

- 用户行为不变；
- PlannerService 可以使用阶段三的测试 Repository；
- Tool / Route 只负责协议转换；
- 数据库事务仍由阶段三的 Repository 实现；
- `src/index.ts` 只装配阶段三 Repository、Service、Tools、Routes 和 Prompt。

## 8. 阶段 4：兼容 Schema（候选 `user_version = 3`）

### 8.0 类型先于存储实现

在编写 v3 DDL 和 Proposal 数据访问之前，先解决会改变持久化结构的业务决策，再在 Core 定义 `PlanProposal`、Snapshot、稳定 local id、ordering constraints、validation 与 JSON 持久化类型，并定义严格 codec。阶段 4 只冻结数据契约，不实现阶段状态机；状态转换在阶段 5 完成。

`db/repo.ts` 不得长期返回 `unknown` JSON，也不得在解析失败时构造空 Snapshot、默认 stage/status 或空 validation。损坏记录必须返回稳定错误。

阶段三的 `PlannerRepository + SqlitePlannerRepository → db/repo.ts` 只是为了先建立调用边界。阶段四在新增 Proposal 数据访问前先做一个不改变行为的收敛提交：删除手写接口和纯转发类，由 `src/db/repo.ts` 导出 `createPlannerRepo(db)` 以及从返回值推导的 `PlannerRepo` 类型；PlannerService 直接接收该对象。DDL 继续由 `src/db/schema.ts` 单独负责。

Service 与数据访问的常规测试使用 `DatabaseSync(':memory:')` 和真实 `db/repo.ts`；SQLite 锁与多连接并发使用临时文件数据库。只有无法稳定制造的技术失败才在单个测试中使用局部结构类型替身，不维护全局 Fake Repository。

阶段 4 决策门采用以下结论；这些结论先于 v3 DDL 和 Proposal 数据访问实现：

1. 容量变化与正式计划变化统一增加 `planner_meta.schedule_version`，不增加 `capacity_version`；
2. `task.seq` 对已有 Phase 内任务按 `(day IS NULL), day, created_at, id` 升序稳定回填为从 1 开始的连续整数；`phase_id IS NULL` 的 legacy loose task 使用同一排序全局编号，但该编号只为兼容列完整性服务，不赋予它 V2 业务归属；
3. 旧 Schema 没有可靠的完成事件时间，不能把 `updated_at` 当成完成时间；所有既有 Task/Phase 的 `completed_at` 初始均为 `null`。兼容读取用旧 `status = 'done'` 保留“已完成”事实，Snapshot 用独立 `isCompleted` 保留该事实；只有新路径在真实完成动作发生时写精确时间；
4. Goal 的 `title / acceptance_criteria / deadline / status` 会影响 ready Proposal，成功变化时增加统一版本，并在 commit 时与 baseline 逐字段比较；`motivation` 不影响 Proposal，也不增加该版本；
5. Goal/Phase `acceptance_criteria` 的 staged 契约是 trim 后 1–1000 字符；兼容列允许 `null` 表达 legacy 未补录，禁止用空字符串代替；
6. 第一版不允许 override 超容量或超过截止日期，正式 verdict 只使用 `valid / invalid`；
7. `PlanProposal`、两个 Snapshot、local id、ordering constraints 与 validation JSON 的准确结构以 `ARCHITECTURE_V2.md` 第 4 节为唯一类型契约：一个 Proposal.stage、一份规范化 Candidate、精简 validation；后续 Core codec、DDL 行映射和 `db/repo.ts` 不得另定义近似结构。

### 8.1 目标

在 legacy 默认行为不变的版本中先引入 V2 所需的持久化结构。该版本是数据库升级后的安全回滚基线。

V2 只新增一个候选计划工作流对象 `PlanProposal`，对应 `plan_proposal` 表。本文中的“草稿”和“提案”不是两份数据：`PlanProposal` 在提交前属于草稿数据，进入 `ready` 只表示同一条记录可以预览和确认。旧 `draft` 表仅服务 legacy 流程，不是 V2 Proposal 的前置存储。

建议新增表：

```sql
create table plan_proposal (
  id                    text primary key,
  goal_id               text not null references goal(id),
  owner_session_id      text not null,
  operation             text not null,
  stage                 text not null,
  status                text not null,
  revision              integer not null,
  base_schedule_version integer not null,
  baseline_json         text not null,
  candidate_json        text not null,
  validation_json       text not null,
  created_at            text not null,
  updated_at            text not null,
  expires_at            text
);

create table planner_meta (
  key        text primary key,
  value      text not null,
  updated_at text not null
);
```

建议索引：

- `(owner_session_id, status, updated_at)`；
- `(goal_id, status, updated_at)`；
- `(status, expires_at)`。

建议给正式表增量增加：

- `goal.acceptance_criteria`，初始可空；
- `phase.acceptance_criteria`，初始可空；
- `phase.completed_at`，初始可空；
- `task.seq`，旧数据按现有稳定顺序回填；
- `task.completed_at`，旧数据保持 `null`，只由迁移后的真实完成动作写入。

本项目 v2 数据没有可靠的 Task/Phase 完成事件时间，因此本次迁移不做时间回填：新增的 `completed_at` 对全部旧记录保持 `null`。旧 `done` 事实继续由 legacy `status` 兼容读取并映射到 Snapshot 的 `isCompleted = true`，不得伪造时间。

首个兼容迁移不得：

- 删除或重命名 `draft`；
- 删除或重建正式表；
- 删除 `status` 列；
- 删除 `doing / dropped` 历史记录；
- 把旧 `draft` 记录自动解释为 V2 `PlanProposal`；
- 修改现有 Goal、Phase、Task id。

### 8.2 旧状态兼容

新写入路径只产生 V2 允许的状态；旧状态按兼容读取处理：

- `task.done`：视为已完成，保留并回填 `completed_at`；
- `task.todo`：视为未完成；
- `task.doing`：迁移阶段不丢失，V2 读取时暂按未完成处理；
- `task.dropped`：保留历史但不进入新的 candidate 和未来容量；
- phase 的旧状态同理保留，完成状态优先映射到 `completed_at`。

是否在后续版本物理清理旧状态，必须另做数据决策和独立迁移，不能夹在 V2 首次发布中。

### 8.3 schedule_version

`planner_meta.schedule_version` 初始为 `0`。任何会改变正式阶段、任务内容或排期的成功事务都必须增加它。

容量成功变化统一增加 `schedule_version`。schedule validation 持久化 Candidate 涉及日期的 `limit / externalPlannedMinutes / candidatePlannedMinutes`；commit 发现版本变化后重读最新状态。若这些日期的容量输入或外部占用改变，Proposal 必须变为 `stale` 并重新预览，不能沿用旧预览静默提交；只影响无关日期的版本变化可以在复用同一确定性 Validator 重校验通过后继续。

Goal 的 `title / acceptance_criteria / deadline / status` 成功变化同样增加 `schedule_version`，并在 commit 锁内与 baseline 逐字段比较；任一字段变化都使旧 Proposal `stale`。`motivation` 不参与 Proposal 合法性，更新它不增加版本。

### 8.4 兼容标签

Schema 合并且 legacy 仍为默认后，建立兼容标签，例如：

```text
planner-v2-compat
```

数据库升级后，Git 回滚最低只能回到这个标签或更晚版本。当前只认识 v2 的版本不是安全回滚目标。

在兼容标签尚未由用户确认建立前，最低回滚基线是任何明确支持 `SCHEMA_VERSION = 3` 的提交；不得回滚到只认识 v2 Schema 的版本，也不得通过降低 `PRAGMA user_version` 伪装回滚。

## 9. 阶段 5：新建计划纵向切片

只实现：

```text
正式创建 Goal
  → start create Proposal
  → structure
  → estimate
  → schedule
  → ready（仍是同一条 Proposal，仅变为可预览、可确认）
```

此阶段不实现：

- reschedule；
- modify；
- replan；
- 删除 legacy；
- 正式历史版本浏览。

阶段 5 的状态机、Validator 和 Service 必须复用阶段 4 已冻结的 Proposal 类型，不得为 Tool 或 `db/repo.ts` 再定义一套近似类型。

配置开关：

```yaml
planningFlow: legacy | staged
```

要求：同一个 Agent 只能看到一套规划工具。

- `legacy`：只注册旧 propose / commit；
- `staged`：只注册新场景入口和 Proposal 工具。

阶段 5 的 staged 仅用于开发与 Agent Eval；在阶段 6 的 Preview/Commit 闭环完成前不得成为发布默认值。

验收：

- 第一段不能携带时长和日期；
- 第二段只能补时长；
- 任务边界错误能退回第一段；
- 第三段只能补日期；
- 每次 advance 使用 expected revision；
- ready 前不能 commit；
- 插件内不直接调用 `ctx.llm`。

## 10. 阶段 6：Preview 与提交

实现顺序：

1. Core Diff；
2. PlannerService Preview Query；
3. 月份裁剪 API；
4. Client Model；
5. React 红绿预览；
6. Proposal 确认、取消修改、放弃的 Service/Route，以及 optimistic concurrency commit；
7. Client 接入并启用确认、取消修改、放弃操作。

Host API 必须从可信宿主上下文获得 Session 身份，不接受客户端自行声明 `owner_session_id`。commit 可以在事务外预检查，但获得 `BEGIN IMMEDIATE` 写锁后必须重新检查 owner、revision、status 与正式版本，并用 expected revision 条件更新 Proposal。

关键验收：

- Preview 展示的 candidate 与 commit 写入完全一致；
- structure、estimate、schedule 和 ready 始终更新同一条 `plan_proposal`，ready 时不复制记录；
- commit 不调用 Agent 或 LLM；
- commit 不自动改日期或任务；
- 属性修改按 removed + added 展示；
- 跨月移动在两个视口读取同一 Proposal 后结果一致；
- 修改 Proposal revision 后旧页面确认请求被拒绝；
- 正式 schedule_version 改变时旧 Proposal 不静默覆盖。

## 11. 阶段 7：其余场景

按顺序实现：

1. reschedule：只允许日期变化；
2. modify：按最早受影响阶段回退；
3. replan：保留完成内容，替换未完成内容。

每个场景单独形成小分支或小提交，不共用一个大提交。四个场景共用 Proposal Engine、Validator、Diff 和 Commit。

## 12. 阶段 8：切换与清理

切换前需要：

- staged 新建、预览、提交通过 Agent Eval；
- 真实数据库副本完成迁移和回放；
- legacy / staged 对同一正式计划的查询结果一致；
- 失败时可以通过配置立即切回 legacy；
- 文档与工具目录同步。

切换步骤：

1. 默认改为 staged，保留 legacy 开关；
2. 观察一个稳定周期；
3. 删除 `makeJudgeChat`、旧 Judge 与 Reschedule 调用；
4. 删除 legacy Tool 注册；
5. 删除 `planningFlow: legacy` 配置值；旧配置必须收到明确迁移错误，不得静默 fallback；
6. 保留旧表只读至少一个发布周期；
7. 是否物理删除旧表另开后续迁移。

## 13. 提交与质量门禁

建议提交粒度：

```text
test: lock legacy proposal behavior
refactor(core): extract capacity validation
refactor(host): introduce planner service facade
refactor(api): route task updates through planner service
feat(storage): add staged proposal schema
feat(core): add proposal stage transitions
feat(tools): expose structured proposal advancement
feat(web): add monthly proposal diff
feat(client): render proposal preview
feat(host): commit proposal with optimistic concurrency
refactor(ai): remove direct judge and reschedule calls
```

每个小提交先运行覆盖其改动面的定向测试、类型检查或构建；不要因为只修改一个局部就无条件启动无关的全项目矩阵。每个阶段准备合并时必须通过完整门禁：

```powershell
npm test
npm run check
npm run build
```

禁止合并：

- 编译失败的中间提交；
- 同时包含大量文件移动和行为改写的提交；
- 没有迁移测试的 Schema 变更；
- 没有 Tool Eval 的相似工具扩张；
- 使用真实用户数据库作为自动化测试输入；
- 吞掉异常或把数据库、解析、事务失败伪装成空结果、默认值或成功；
- 在 Tool、Service、`db/repo.ts` 多层复制同一业务校验；
- 对不可恢复错误或非幂等写入进行无上限重试；
- 同时向 legacy `draft` 与 staged `plan_proposal` 双写同一提案；
- 没有明确删除阶段和退出条件的兼容分支。

测试范围遵循风险分层：

- 文档、注释或纯展示文案：格式、链接和受影响文档检查；
- 单个纯函数或 Validator：相关单测与 typecheck；
- Adapter 或 Service 接线：相关特征测试、typecheck，必要时 build；
- Schema、事务、并发、Tool Schema、发布切换：相关专项测试后再跑完整门禁；
- 用户明确要求运行某个单项测试时，只运行该范围，除非发现会阻断判断的直接依赖。

## 14. 数据库演练与备份

每次迁移必须执行：

1. 创建临时目录；
2. 复制真实数据库及 WAL/SHM 的一致快照，或在安全停写后复制；
3. 在副本上运行迁移；
4. 校验 `PRAGMA integrity_check`；
5. 比较 Goal、Phase、Task 数量和关键 id；
6. 用新旧查询路径生成相同正式日历；
7. 重复打开数据库，验证迁移幂等；
8. 测试 staged Proposal，不影响正式数据；
9. 记录迁移耗时和失败恢复方式。

真实升级前必须有可恢复备份。备份恢复应作为发布检查项实际演练一次，而不是只确认文件存在。

## 15. 回滚矩阵

| 失败位置 | 首选处理 | 数据处理 |
|---|---|---|
| Core / Service 重构 | Git 回滚对应提交 | 无 Schema 变化 |
| 兼容 Schema 迁移 | 回到 `planner-v2-compat` | 新表可保留为空 |
| staged Tool 异常 | 配置切回 `legacy` | Proposal 保留，不碰正式数据 |
| Preview 异常 | 禁止确认，切回 legacy | 正式数据不变 |
| commit 前版本冲突 | Proposal 标记 stale | 重新生成预览 |
| commit 事务失败 | SQLite 回滚事务 | schedule_version 不增加 |
| staged 默认切换后异常、legacy 尚未清理 | 切回 legacy，再修代码 | 不降级数据库版本 |
| legacy 代码已经清理后异常 | 停止受影响入口并向前修复 | 不接受已删除的 legacy 配置，不降级数据库版本 |

不通过降低 `PRAGMA user_version` 伪装回滚，也不让旧二进制打开它不认识的新 Schema。

## 16. 阶段 0 完成条件

第一阶段完成需要：

- 三份设计文档进入独立 Git 分支；
- 生产代码、package、schema 均未修改；
- `NEW_PLANNING_FLOW.md` 不再描述插件内部裸 LLM 流水线；
- 架构依赖方向明确；
- Git 与数据库迁移顺序明确；
- 待评审业务决策集中列出；
- 后续第一条代码分支明确为旧行为特征测试，而不是直接实现新功能。
