# Personal Planner Architecture V2

> 状态：提案，等待评审。
>
> 目的：冻结下一版的模块边界和依赖方向，避免在实现三阶段规划时继续向 `tools.ts`、`routes.ts` 和 React 组件堆叠业务逻辑。
>
> 本文只描述目标架构；当前真实实现以源码和数据库迁移代码为准，业务流程以 [`NEW_PLANNING_FLOW.md`](./NEW_PLANNING_FLOW.md) 为准，数据库演进以 [`MIGRATION_V2.md`](./MIGRATION_V2.md) 为准。

## 1. 架构目标

V2 必须同时满足：

1. 复用 DeepSeek Harness 当前会话中的 Agent，不在插件工具内部维护另一套裸 LLM 循环；
2. 正式业务层级始终只有 `Goal → Phase → Task`；
3. 同一份待确认提案按结构、估时、排期三个阶段推进；
4. Tools、GUI 和其他 Host 入口共享一套业务服务，不能各自直接操作 Repo；
5. 确定性规则可测试、可重放，语义判断由 DSH Agent 结合 System Prompt 与 Skill 完成；
6. 用户确认前不修改正式阶段和任务；
7. 最终提交必须是短事务，不能在事务中等待 Agent、模型或用户；
8. Host 是正式计划和提案的权威状态源，Client 只保存视图状态。

## 2. 总体结构

采用 DSH 插件中常见的 **Host / Client / Core + Adapters** 结构，不套用严格 DDD 分层。

```text
                         DeepSeek Harness Agent
                                  │
                         System Prompt / Skill
                                  │
                             Planner Tools
                                  │
                                  ▼
Calendar Client ── Host API ──▶ PlannerService
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                  Proposal Engine     Query / Diff
                         │                 │
                         └────────┬────────┘
                                  ▼
                         PlannerRepository
                                  │
                                  ▼
                               SQLite
```

依赖只能向下：

```text
Client / DSH Tool / HTTP Route
              ↓
        PlannerService
          ↙       ↘
       Core      Repository interface
                        ↑
                SQLite implementation
```

禁止的依赖：

- Core 依赖 Cordis、DSH、SQLite、HTTP 或 React；
- Tool、Route、React 组件直接执行 SQL；
- Route 或 Tool 各自实现容量、提案推进或提交规则；
- Repository 决定业务状态如何流转；
- commit 调用 Agent、LLM 或修改用户尚未预览的候选方案。

## 3. 模块职责

### 3.1 Core

建议结构：

```text
src/core/
├── types.ts
├── policy.ts
├── proposal.ts
├── diff.ts
└── validation/
    ├── structure.ts
    ├── estimate.ts
    ├── schedule.ts
    └── capacity.ts
```

Core 包含纯类型和纯函数：

- Goal、Phase、Task、PlanProposal；
- 三阶段字段契约；
- Proposal 状态机；
- 阶段退回与失效规则；
- 日期、容量和依赖约束校验；
- baseline 与 candidate 的 Diff；
- 结构化 Validation Issue。

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/core/types.ts` | 定义 Goal、Phase、Task、Proposal、Snapshot、Diff、Command Result 等跨模块类型，以及无副作用的值对象构造 |
| `src/core/policy.ts` | 定义阶段枚举、字段许可表、数值阈值、合法转换和稳定错误码，作为 Prompt、Tool Schema 与 Validator 的规则来源 |
| `src/core/proposal.ts` | 用纯函数实现 Proposal 状态转换、revision 推进、阶段退回、下游字段失效和终态保护 |
| `src/core/diff.ts` | 按正式 id 与 draft-local id 比较 baseline/candidate，生成 added、removed、unchanged 和变更摘要，并支持按日期范围裁剪 |
| `src/core/validation/structure.ts` | 检查结构阶段字段、空阶段、顺序、数量边界、缺失归属和可确定识别的重复项 |
| `src/core/validation/estimate.ts` | 检查估时完整性、15 分钟刻度、15–120 分钟范围和可确定识别的碎片比例，并指出是否必须退回结构阶段 |
| `src/core/validation/schedule.ts` | 检查日期格式、排期窗口、required ordering、截止日期和候选排期的内部一致性 |
| `src/core/validation/capacity.ts` | 根据调用方提供的正式占用和 candidate 计算每日负载、剩余容量和硬性容量问题 |

`policy.ts` 是稳定规则的单一代码来源，至少定义：

- 阶段枚举和合法转换；
- 每阶段允许、必需和禁止的字段；
- 15 分钟估时刻度；
- 15–120 分钟任务范围；
- 结构数量阈值；
- 容量硬限制。

System Prompt、Tool Schema 和校验器应引用同一组常量，或由测试证明它们保持一致。

### 3.2 PlannerService

`src/host/planner-service.ts` 是所有业务用例的唯一入口。

建议接口按命令和查询组织：

```ts
interface PlannerService {
  createGoal(command: CreateGoalCommand): Goal
  updateGoal(command: UpdateGoalCommand): Goal

  startProposal(command: StartProposalCommand): StartProposalResult
  advanceProposal(command: AdvanceProposalCommand): AdvanceProposalResult
  getProposal(query: GetProposalQuery): ProposalView
  discardProposal(command: DiscardProposalCommand): void
  commitProposal(command: CommitProposalCommand): CommitProposalResult

  queryCalendar(query: CalendarQuery): CalendarView
  queryProposalPreview(query: ProposalPreviewQuery): ProposalPreview
  updateTask(command: UpdateTaskCommand): Task
  updateCapacity(command: UpdateCapacityCommand): CapacityRules
}
```

PlannerService 负责：

- 加载正式计划和容量上下文；
- 创建 baseline 与 candidate；
- 调用 Core 推进提案；
- 保存 Proposal revision；
- 检查 session 所有权；
- 处理 `schedule_version`；
- 检测会影响 Proposal 的 Goal 字段、容量和正式计划变化；
- 组织提交事务；
- 产生 Client 和 Tool 所需的结构化结果。

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/host/planner-service.ts` | 实现 Goal、Proposal、Calendar、Task、Capacity 用例，加载上下文，调用 Core，协调 Repository，检查 Session、revision 与 schedule version，并返回结构化业务结果 |

### 3.3 Repository

`PlannerRepository` 是 PlannerService 与 SQLite 之间的窄接口。它的目的不是预设将来一定换数据库，而是隔离 SQL、事务和迁移细节，支持 Service 单测。

建议结构：

```text
src/host/
├── repository.ts
├── sqlite-repository.ts
└── schema.ts
```

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/host/repository.ts` | 定义 PlannerRepository 接口、查询条件、事务输入输出和持久化错误类型，供 Service 与测试实现依赖 |
| `src/host/sqlite-repository.ts` | 实现 PlannerRepository，负责 SQL、行映射、预编译语句、条件更新、事务和 SQLite 错误归一化 |
| `src/host/schema.ts` | 定义 schema version、DDL、向前迁移、数据库打开参数和迁移完整性检查 |

Repository 负责：

- Goal、Phase、Task、Proposal 的持久化；
- 按范围查询任务和容量占用；
- revision 条件更新；
- `BEGIN IMMEDIATE` 提交事务；
- schema migration。

Repository 返回业务数据，不返回面向用户的自然语言错误。并发、约束和缺失记录使用稳定错误类型交给 Service 解释。

### 3.4 DSH Tools

建议结构：

```text
src/host/tools/
├── index.ts
├── goals.ts
├── plans.ts
├── tasks.ts
└── presentation.ts
```

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/host/tools/index.ts` | 汇总 ToolDefinition，统一注册和释放，并根据 `planningFlow` 选择 legacy 或 staged 工具集 |
| `src/host/tools/goals.ts` | 定义目标创建、查询和允许的目标更新工具，并把参数映射为 PlannerService Goal Command |
| `src/host/tools/plans.ts` | 定义四种场景入口和 Proposal advance/get/commit/discard，从 `exec.agent` 提取 Session 身份，并声明结构化输入输出 |
| `src/host/tools/tasks.ts` | 定义正式任务查询、完成等无需重做计划的操作，并把会改变计划结构或日期的请求引导到 Proposal 场景 |
| `src/host/tools/presentation.ts` | 把结构化 Tool 结果映射为模型可读 ContentBlock 和通用 Tool 卡片，统一标题、摘要和错误展示 |

Tool 是 DSH Agent 到 PlannerService 的适配器，只负责：

1. 模型可见的名称、描述和参数 Schema；
2. 从 `exec.agent` 获取当前 Session 身份；
3. 把参数转换为 Service Command；
4. 返回符合 Output Schema 的结构化值；
5. 用 `render()`生成模型可读摘要；
6. 必要时用 Tool Presentation 提供通用卡片。

#### 场景入口

V2 暂定向 Agent 暴露四个语义互斥的场景入口：

| Tool | 使用场景 | 初始阶段 |
|---|---|---|
| `planner_plan_create` | 已有正式目标，创建全新计划 | `structure` |
| `planner_plan_reschedule` | 只改变未完成任务日期 | `schedule` |
| `planner_plan_modify` | 局部修改阶段、任务或估时 | 由最早受影响字段决定 |
| `planner_plan_replan` | 保留完成内容，整体替换未完成计划 | `structure` |

四个入口只建立提案上下文，不分别实现四套规划引擎。

#### 共用提案工具

| Tool | 职责 |
|---|---|
| `planner_proposal_advance` | 提交当前阶段产物，保存、校验并推进或退回 |
| `planner_proposal_get` | 恢复提案状态和下一步所需的有限上下文 |
| `planner_proposal_commit` | 用户确认后提交 ready 提案 |
| `planner_proposal_discard` | 明确放弃当前提案 |

是否最终保留四个场景入口，还是通过评估收敛成一个带 `operation` 的入口，属于 Tool Eval 决策；PlannerService 的四个场景语义不受 Tool 表面数量影响。

### 3.5 Host API

`src/host/routes.ts` 只负责：

```text
HTTP 输入校验
  → 从可信 Host 上下文取得 Session 身份
  → PlannerService Command / Query
  → HTTP 状态与 JSON Response
```

客户端不得自行声明或覆盖 `ownerSessionId`。Proposal 的读取、预览、修改和确认都必须使用 Host 提供的 Session 身份执行所有权检查。

面向日历的主要查询：

- 正式月份视图；
- 某日正式任务；
- 当前 Session 的活跃 Proposal；
- 某 Proposal 在指定月份的服务端 Diff；
- Proposal 确认、取消修改、彻底放弃。

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/host/routes.ts` | 注册 Host 路由，校验传输层参数，调用 PlannerService，把业务结果映射为 HTTP 状态与 JSON，并处理分页、月份范围和响应裁剪 |

### 3.6 Client

建议结构：

```text
src/client/
├── index.tsx
├── api.ts
├── planner-model.ts
├── PlannerView.tsx
├── ProposalPreview.tsx
└── components/
    ├── CalendarGrid.tsx
    ├── TaskList.tsx
    └── CapacityEditor.tsx
```

`planner-model.ts` 管理：

- 当前月份和选中日期；
- 正式日历视图；
- 当前 Session 的活跃 Proposal；
- Proposal revision；
- 加载、失效、确认和取消；
- Host 变更后的统一刷新。

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/client/index.tsx` | 作为 Client 插件入口注册 conversation slots，并创建、提供 PlannerModel |
| `src/client/api.ts` | 封装 Host API 的类型化请求、响应解析、取消和传输错误 |
| `src/client/planner-model.ts` | 保存月份、选中日期、正式视图、活跃 Proposal 和 revision，组织加载、失效、确认、取消与统一刷新，并向 React 暴露订阅和命令 |
| `src/client/PlannerView.tsx` | 组合正式日历、目标摘要、日期清单和 ProposalPreview，并根据 PlannerModel 状态选择页面模式 |
| `src/client/ProposalPreview.tsx` | 渲染服务端返回的变更摘要、红绿任务、确认/取消/放弃操作和 stale 提示 |
| `src/client/components/CalendarGrid.tsx` | 渲染月份网格、日期选择、正式/预览任务和容量条，并通过回调上报交互 |
| `src/client/components/TaskList.tsx` | 渲染某日任务列表、完成状态及允许的直接操作 |
| `src/client/components/CapacityEditor.tsx` | 编辑容量表单、执行输入层即时校验并提交回调 |

### 3.7 System Prompt 与 Skill

`src/host/prompt.ts` 注入稳定、跨场景的规则：

- Goal / Phase / Task 定义与正反例；
- 四种计划操作的边界；
- 三阶段允许和禁止的字段；
- Tool Result 的处理方式；
- ready 前不能声称正式计划已创建；
- 用户确认前不能 commit。

Skill 只补充具体业务场景知识，例如运营、求职、科研或软件开发的任务粒度、审核链路和缓冲经验。

DSH Agent 是规划智能的拥有者：

```text
System Prompt 定义通用流程
Skill 提供场景知识
Agent 生成与语义评审
Core / Service 执行确定性约束和持久化
```

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/host/prompt.ts` | 从 Core policy 组装并注册稳定 System Prompt section，包含对象定义、流程、工具选择规则和少量正反例 |
| `skills/<scenario>/SKILL.md` | 描述某个业务场景的任务粒度、典型依赖、估时经验和缓冲规则，由 DSH Skill 机制按需提供给 Agent |

### 3.8 插件入口与配置

建议增加独立配置文件，使入口只负责装配：

```text
src/
├── index.ts
└── host/
    └── config.ts
```

文件功能范围：

| 文件 | 负责 |
|---|---|
| `src/index.ts` | 声明 Cordis inject，创建 SQLite Repository 和 PlannerService，注册 Prompt、Tools、Routes 与 disposer，并显式报告启动失败；只按已配置的 `planningFlow` 装配对应工具，不做静默 fallback |
| `src/host/config.ts` | 定义插件配置类型、默认值和启动期校验，包括数据库路径、`planningFlow` 等部署选项 |

### 3.9 失败、校验、重试与兼容边界

#### 失败必须可见

- 禁止空 `catch`、只记录不返回失败、或把异常吞掉后继续走成功路径；
- `catch` 只能用于补充上下文、把已知底层错误映射为稳定错误，或执行清理后重新抛出；原始 `cause` 应保留用于诊断；
- 数据库查询失败不能返回 `0`、`[]`、空对象或 `undefined` 来伪装“没有数据”；“查询成功但没有记录”和“查询失败”必须是不同结果；
- 业务默认值只能用于已经成功确认的缺省状态，例如首次初始化容量；不得用默认值掩盖读取、解析或迁移失败；
- 写事务只有在全部写入、状态更新和版本增加都成功提交后才能返回成功。回滚、约束失败、版本冲突或数据库繁忙都必须返回明确失败，不能返回 `{ success: true }` 或空成功对象。

#### 可空性只留在真实业务边界

- Adapter 在入口处把 `unknown` 输入解析成合法 Command；Core 与 Service 内部对必需字段使用非可空类型；
- `null` 只表达业务上真实存在的“没有值”，例如可选 deadline 或未完成时的 `completedAt`；
- 对契约保证存在的内部字段，不使用 `?.`、`?? 0`、`?? []` 掩盖损坏数据；遇到契约破坏应返回稳定错误；
- SQLite 行映射必须校验必需列和 JSON 内容，损坏记录不能被当作空 Proposal 继续处理。

#### 每条规则只有一个实现所有者

| 层 | 只负责 |
|---|---|
| Tool / HTTP Adapter | 传输格式、基础类型、身份提取和协议映射 |
| PlannerService | 用例编排、所有权、revision、版本和事务边界 |
| Core Validator | 阶段字段、状态转换、容量、依赖、Diff 等确定性业务规则 |
| Repository / SQLite | SQL、约束、条件写入、事务和错误归一化 |
| DSH Agent | 生成、语义判断和按 Tool 结果修订 |

Tool Schema、Prompt 和 GUI 可以表达同一规则，但不能各自复制一份业务校验实现。advance 与 commit 必须复用同一个 Core Validator；commit 在最新正式状态上重跑属于再次调用同一权威实现，不是复制规则。

#### 重试必须有限且可证明安全

- 参数错误、业务校验失败、owner/revision/stage 冲突和硬性约束失败不得自动重试；
- 仅对明确的瞬时技术故障考虑重试，例如数据库 busy 或可恢复传输失败；
- 重试必须有上限、退避和可观测记录；超过上限返回稳定错误；
- 非幂等写入不得在不知道前一次是否提交的情况下盲目重试；使用 revision、事务或幂等键证明安全后才允许重试；
- staged Tool 内不重试或另起 LLM 循环。DSH Agent 是否修订并再次调用 Tool，由 Tool 结构化结果和 Agent Eval 约束。

#### 兼容代码必须有退出条件

- 只支持项目明确声明的 Node、SQLite 和 DSH 版本；不为未支持运行时增加猜测式 fallback；
- legacy 与 staged 通过配置互斥，不能双写 `draft` 与 `plan_proposal`，也不能同时成为事实源；
- 旧 `draft/check_log` 的保留只用于迁移兼容和历史诊断，不为其增加新功能；
- 每条兼容路径必须指向迁移阶段 8 的删除或只读化步骤；在退出门满足后删除旧实现，而不是永久维护两套行为。

## 4. 提案模型

`PlanProposal` 是唯一的规划工作流对象，不是正式业务层级。本文中的“草稿”和“提案”指同一份 `PlanProposal`：草稿强调尚未提交，提案强调准备对正式计划产生的修改。系统不定义另一个草稿对象，也不会在 `ready` 时复制或创建另一份数据。

```ts
interface PlanProposal {
  id: string
  goalId: string
  ownerSessionId: string
  operation: 'create' | 'reschedule' | 'modify' | 'replan'
  stage: 'structure' | 'estimate' | 'schedule' | 'ready'
  status: 'editing' | 'awaiting_confirmation' | 'committed' | 'discarded' | 'stale'
  revision: number
  baseScheduleVersion: number
  baseline: PlanSnapshot
  candidate: ProposalSnapshot
  validation: ProposalValidation
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}
```

上述接口在持久化层使用以下正式枚举，codec 不接受枚举外字符串：

```ts
type ProposalOperation = 'create' | 'reschedule' | 'modify' | 'replan'
type PlanningStage = 'structure' | 'estimate' | 'schedule' | 'ready'
type ProposalStatus = 'editing' | 'awaiting_confirmation' | 'committed' | 'discarded' | 'stale'
```

#### Snapshot v1

`baseline_json` 是创建后不可变的 `PlanSnapshotV1`。它只保存目标本身的规划相关字段、该目标的 V2 可见 Phase/Task，以及兼容完成事实；legacy `dropped` 对象不进入 Snapshot，legacy `doing` 按未完成读取。

```ts
type CompletionSnapshot =
  | { isCompleted: false; completedAt: null }
  | { isCompleted: true; completedAt: string | null } // null 仅允许 legacy 无可靠完成时刻

interface PlanSnapshotV1 {
  schemaVersion: 1
  goal: {
    id: string
    title: string
    acceptanceCriteria: string | null // null 仅允许 legacy 未补录
    deadline: string | null
    status: 'active' | 'done' | 'dropped'
  }
  phases: Array<{
    id: string
    title: string
    acceptanceCriteria: string | null
    seq: number
    completion: CompletionSnapshot
    tasks: Array<{
      id: string
      title: string
      priority: 'P0' | 'P1' | 'P2'
      estMinutes: number
      day: string | null
      seq: number
      completion: CompletionSnapshot
      actualMinutes: number | null
      note: string | null
    }>
  }>
}
```

`candidate_json` 是 `ProposalSnapshotV1`。`contentStage` 是当前已持久化内容的完整度，不等同于 `PlanProposal.stage`（后者表示下一步允许提交什么）。字段必须按 discriminated union 严格出现：structure 不得含 `estMinutes/day`，estimate 必须含 `estMinutes` 且不得含 `day`，schedule 必须同时含两者。`ready` 只允许 `contentStage = 'schedule'`。

```ts
interface ProposalPhaseBase<TaskShape> {
  localId: PhaseLocalId
  sourcePhaseId: string | null
  title: string
  acceptanceCriteria: string
  seq: number
  completion: CompletionSnapshot
  tasks: TaskShape[]
}

interface ProposalTaskBase {
  localId: TaskLocalId
  sourceTaskId: string | null
  title: string
  priority: 'P0' | 'P1' | 'P2'
  seq: number
  completion: CompletionSnapshot
}

type StructureTask = ProposalTaskBase
type EstimateTask = ProposalTaskBase & { estMinutes: number }
type ScheduleTask = ProposalTaskBase & { estMinutes: number; day: string }

type ProposalSnapshotV1 =
  | { schemaVersion: 1; contentStage: 'structure'; phases: Array<ProposalPhaseBase<StructureTask>> }
  | { schemaVersion: 1; contentStage: 'estimate'; phases: Array<ProposalPhaseBase<EstimateTask>> }
  | { schemaVersion: 1; contentStage: 'schedule'; phases: Array<ProposalPhaseBase<ScheduleTask>> }
```

删除通过“baseline 中有、candidate 中无”表达，不引入 tombstone。`sourcePhaseId/sourceTaskId` 连接 baseline 正式对象；新对象对应值必须为 `null`。completed 对象在允许保留它们的场景中保持同一 source id、local id 和内容，具体不可变范围在阶段 7 场景决策中冻结。

#### 稳定 local id 与 ordering constraints

所有 Candidate Phase/Task（包括从 baseline 复制的对象）都由 Host 分配一次 local id，并在 Proposal 全生命周期内保持不变。格式分别为 canonical lowercase UUID 前加 `plp_` 与 `plt_`，即 `plp_550e8400-e29b-41d4-a716-446655440000` 和 `plt_...`。Agent 只能引用已有 local id，不能提供、替换或按标题生成 id。Codec 必须拒绝格式错误、重复、source id 重复、Task source 与 Phase source 归属矛盾。

```ts
type PhaseLocalId = `plp_${string}`
type TaskLocalId = `plt_${string}`

interface OrderingConstraint {
  predecessorTaskLocalId: TaskLocalId
  successorTaskLocalId: TaskLocalId
  strength: 'required' | 'preferred'
  reason: string // trim 后 1–500 字符
}
```

约束只能引用同一 Candidate 中两个不同 Task；重复边、required 环和悬空引用是损坏或确定性校验错误。结构变化使全部 ordering constraints 失效；只改日期时复用并重检现有约束。

#### validation_json v1

第一版不允许容量或截止日期 override，因此 verdict 只有 `valid / invalid`。初建 Proposal 尚未校验不是空 validation 或解析 fallback，而是显式、带 revision 的 `pending` 分支。

```ts
type ProposalValidationCode =
  | 'STRUCTURE_FIELD_FORBIDDEN' | 'STRUCTURE_COUNT' | 'STRUCTURE_EMPTY_PHASE'
  | 'STRUCTURE_SEQUENCE' | 'STRUCTURE_DUPLICATE_LOCAL_ID' | 'STRUCTURE_DUPLICATE_ITEM'
  | 'ESTIMATE_IDENTITY_CHANGED' | 'ESTIMATE_MISSING' | 'ESTIMATE_INCREMENT' | 'ESTIMATE_RANGE'
  | 'SCHEDULE_IDENTITY_CHANGED' | 'SCHEDULE_DATE_FORMAT' | 'SCHEDULE_DEADLINE'
  | 'SCHEDULE_DEPENDENCY_CYCLE' | 'SCHEDULE_REQUIRED_ORDER' | 'SCHEDULE_CAPACITY'
  | 'SNAPSHOT_REFERENCE_INVALID'

interface ProposalValidationIssue {
  code: ProposalValidationCode
  stage: 'structure' | 'estimate' | 'schedule'
  message: string
  phaseLocalId: PhaseLocalId | null
  taskLocalId: TaskLocalId | null
  day: string | null
}

interface CapacityValidationDay {
  day: string
  limitMinutes: number
  externalPlannedMinutes: number
  candidatePlannedMinutes: number
}

type OrderingValidation =
  | { state: 'not_applicable' }
  | { state: 'complete'; constraints: OrderingConstraint[] }

type CapacityValidation =
  | { state: 'not_applicable' }
  | { state: 'checked'; days: CapacityValidationDay[] }

type ProposalValidationV1 =
  | {
      schemaVersion: 1
      state: 'pending'
      candidateRevision: number
      requiredStage: 'structure' | 'estimate' | 'schedule'
    }
  | {
      schemaVersion: 1
      state: 'evaluated'
      candidateRevision: number
      contentStage: 'structure' | 'estimate' | 'schedule'
      verdict: 'valid' | 'invalid'
      issues: ProposalValidationIssue[]
      ordering: OrderingValidation
      capacity: CapacityValidation
      validatedAt: string
      scheduleVersion: number
    }
```

`candidateRevision` 必须等于所属 Proposal 的 `revision`；`contentStage` 必须等于当前 candidate 的 discriminant。失败的 advance 输入不替换已持久化 candidate，也不把针对被拒绝输入的 validation 伪装成当前 candidate 的结果；失败 issue 直接作为命令结果返回。`schedule` 的有效结果必须具有 `ordering.state = 'complete'` 和 `capacity.state = 'checked'`。

#### 严格 JSON codec

阶段 4.3 在 Core 为三个 JSON 列分别提供版本化 encode/decode。decoder 的边界输入可以是 `unknown`，但成功后只返回上述正式类型；`unknown` 不得穿透到 Repository/Service。Codec 必须递归拒绝未知键、缺失键、非法枚举、非有限整数、错误 nullability、非法日期/UUID、重复 local/source id 和跨引用错误；不得补默认 stage/status/revision、空 Snapshot、空 validation 或静默忽略字段。JSON 语法错误与契约损坏统一映射为带列名和 Proposal id 的稳定 `PROPOSAL_DATA_CORRUPT` 持久化错误，同时保留底层 cause。

### 4.1 完整快照语义

- `baseline` 创建后不可变，表示提案开始时的正式状态；
- `candidate` 始终保存同一份 `PlanProposal` 当前的完整候选计划；
- 每次阶段提交用 `expectedRevision` 做 compare-and-set；
- V2 第一版不保存每个历史 revision，只保存最新版本；
- `validation` 保存当前版本的结构化校验结果；
- Agent 得到的是当前阶段所需的裁剪上下文，GUI 按月份读取服务端 Diff。

`PlanProposal` 从 `structure` 阶段开始创建并持久化。`structure → estimate → schedule` 是同一份数据逐步完整的过程；`ready` 只表示当前 revision 已可预览和确认，不产生新的 Proposal 记录。

### 4.2 草稿内身份

新阶段和任务必须有稳定的 draft-local id：

- 第二段通过 task local id 补估时；
- 第三段通过同一 id 补日期；
- 正式记录使用 `sourcePhaseId / sourceTaskId` 关联 baseline；
- 新建对象在 commit 时获得正式 id；
- Diff 不能使用标题猜测对象身份。

### 4.3 状态与阶段分离

- `stage` 表示内容推进到了哪里；
- `status` 表示提案能否继续编辑、预览或提交；
- `ready` stage 只能搭配 `awaiting_confirmation` status；
- `committed / discarded / stale` 是终态，不能继续 advance；
- 修改 ready 提案时继续更新同一份 `PlanProposal`，先回到相应阶段并增加 revision，旧预览立即失效。

## 5. 三阶段执行

同一个 DSH Agent 在一个或多个 Step 中推进同一 Proposal；用户不逐段确认。

```text
场景入口 Tool
  ↓ startProposal
structure 上下文
  ↓ Agent 生成并自检
planner_proposal_advance
  ├── revise_required → Agent 修订当前阶段
  └── accepted → estimate
                    ↓
               Agent 估时并自检
                    ↓
          planner_proposal_advance
  ├── revise_required → 修订估时
  ├── return_to_structure → 重做任务边界
  └── accepted → schedule
                    ↓
               Agent 排期并自检
                    ↓
          planner_proposal_advance
  ├── revise_required → 修订日期
  ├── decision_required → 把选择交给用户
  └── ready_for_preview → 日历最终预览
```

阶段工具返回结构化结果，不用自然语言中的“错误：”表示业务失败：

```ts
type AdvanceProposalResult =
  | { status: 'accepted'; proposal: ProposalRef; nextStage: PlanningStage }
  | { status: 'revise_required'; proposal: ProposalRef; issues: ValidationIssue[] }
  | { status: 'return_to_structure'; proposal: ProposalRef; issues: ValidationIssue[] }
  | { status: 'decision_required'; proposal: ProposalRef; decision: UserDecision }
  | { status: 'ready_for_preview'; proposal: ProposalRef; summary: ChangeSummary }
```

技术错误使用稳定错误码，例如：

- `PROPOSAL_NOT_FOUND`；
- `PROPOSAL_REVISION_CONFLICT`；
- `PROPOSAL_STAGE_MISMATCH`；
- `PROPOSAL_NOT_READY`；
- `SCHEDULE_VERSION_CONFLICT`；
- `DATABASE_BUSY`。

## 6. Preview 与 Commit

Host 根据同一份 `PlanProposal` 的 `baseline + candidate` 计算 Diff。Diff 是派生的预览结果，不是另一份提案，也不作为独立业务对象参与三阶段状态流转；Client 不重复实现对象匹配。

Preview 的月份查询只返回当前视口需要的数据：

- 正式未变化任务；
- `added`；
- `removed`；
- 同一正式任务的属性变化按一条 removed + 一条 added 展示；
- candidate 状态下的每日新容量。

commit 的固定顺序：

```text
事务外预检查 Proposal id / owner / revision / ready
  ↓
BEGIN IMMEDIATE
  ↓
重新检查 Proposal owner / revision / status 与 schedule/capacity version
  ↓
读取最新 schedule_version 和受影响正式对象
  ↓
检查 baseline 是否仍可应用
  ↓
按最新正式日历重跑全部确定性约束
  ↓
原子写入 Goal / Phase / Task 变化
  ↓
Proposal → committed
schedule_version + 1
  ↓
COMMIT
```

Proposal 的 committed 更新必须带 expected revision 条件。事务外检查只用于尽早失败，不能替代锁内复查和 compare-and-set。

事务中禁止：

- 调用 Agent 或 LLM；
- 等待用户；
- 重新生成任务、估时或日期；
- 把候选方案自动改成用户没有预览过的新方案。

如果最新状态要求改变 candidate，当前 Proposal 标记为 `stale`，基于最新正式状态生成新的预览并重新确认。

## 7. 测试边界

### Core

- 状态机合法与非法转换；
- 三阶段字段限制；
- 估时刻度与范围；
- 容量和依赖校验；
- baseline / candidate Diff；
- 退回结构阶段时下游字段失效。

### PlannerService

- Session 所有权；
- revision compare-and-set；
- 四种操作的初始阶段；
- ready、discard、stale、commit；
- 两个 Session 的并发提交；
- 提交时最新容量变化。

### Adapters

- Tool Schema 与结构化结果；
- Tool Error code；
- Route 只做协议转换；
- Client Preview 行为；
- GUI 确认结果与 Preview candidate 完全一致。

### Agent Eval

- 是否先创建正式目标；
- 是否选择正确场景入口；
- 第一段是否夹带时长和日期；
- 第二段边界错误时是否退回第一段；
- 是否未经用户确认调用 commit；
- `decision_required` 是否真的交给用户；
- 工具调用次数、Token、耗时和重试次数。

## 8. 目标目录

```text
src/
├── index.ts
├── core/
│   ├── types.ts
│   ├── policy.ts
│   ├── proposal.ts
│   ├── diff.ts
│   └── validation/
│       ├── structure.ts
│       ├── estimate.ts
│       ├── schedule.ts
│       └── capacity.ts
├── host/
│   ├── config.ts
│   ├── planner-service.ts
│   ├── repository.ts
│   ├── sqlite-repository.ts
│   ├── schema.ts
│   ├── prompt.ts
│   ├── routes.ts
│   └── tools/
│       ├── index.ts
│       ├── goals.ts
│       ├── plans.ts
│       ├── tasks.ts
│       └── presentation.ts
└── client/
    ├── index.tsx
    ├── api.ts
    ├── planner-model.ts
    ├── PlannerView.tsx
    ├── ProposalPreview.tsx
    └── components/
        ├── CalendarGrid.tsx
        ├── TaskList.tsx
        └── CapacityEditor.tsx
```

`src/index.ts` 最终只负责装配与生命周期：

```text
创建 SQLite Repository
  → 创建 PlannerService
  → 注册 Prompt
  → 注册 Tools
  → 注册 Host API
  → 注册清理函数
```

## 9. 实施约束

1. 架构移动和业务行为变化不能混在同一个提交；
2. 在新 Proposal 流程完整前保留旧流程作为兼容路径；
3. legacy 与 staged Tool 不得同时暴露给同一个 Agent；
4. 数据库先做向后兼容的增量迁移，再启用 staged flow；
5. 每个合并提交必须通过 test、typecheck 和 build；
6. 新建计划先形成完整纵向切片，再实现 reschedule / modify / replan；
7. 删除旧 Judge、Reschedule 和 Draft 必须放在最终独立清理阶段。

## 10. 待评审决策

以下问题不影响模块边界，但会阻塞具体 Tool Schema 或业务实现：

1. 四个场景入口 Tool 与单一 `planner_plan_start(operation)` 哪个在 Tool Eval 中更可靠；
2. 阶段、任务数量阈值；
3. required 依赖是否允许安排在同一天；
4. Proposal 的默认过期策略；
5. 是否在第一版引入独立 DSH Subagent Reviewer，还是先由当前 Agent 自检并通过 Eval 判断效果。

这些决策确认前可以完成旧行为测试和纯架构边界重构。会影响 `PlanProposal`、Snapshot、validation 或 Schema 字段的决策必须在阶段 4 定义类型和 DDL 前确认；其余决策最迟在最终 Tool Schema 与 staged flow 实现前确认。
