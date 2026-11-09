# Personal Planner Architecture V2

> 状态：提案，等待评审。
>
> 目的：冻结下一版的模块边界和依赖方向，避免在实现三阶段规划时继续向 `tools.ts`、`routes.ts` 和 React 组件堆叠业务逻辑。
>
> 本文只描述目标架构；当前真实实现以 [`STATE.md`](./STATE.md) 为准，业务流程以 [`NEW_PLANNING_FLOW.md`](./NEW_PLANNING_FLOW.md) 为准，数据库演进以 [`MIGRATION_V2.md`](./MIGRATION_V2.md) 为准。

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

Core 不读数据库、不调用模型、不发送请求、不拼 UI 文案。

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
- 组织提交事务；
- 产生 Client 和 Tool 所需的结构化结果。

PlannerService 不负责：

- 理解自然语言用户请求；
- 生成任务、估时或日期；
- 直接调用 LLM；
- 拼接 HTTP Response 或 React 视图。

### 3.3 Repository

`PlannerRepository` 是 PlannerService 与 SQLite 之间的窄接口。它的目的不是预设将来一定换数据库，而是隔离 SQL、事务和迁移细节，支持 Service 单测。

建议结构：

```text
src/host/
├── repository.ts
├── sqlite-repository.ts
└── schema.ts
```

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
├── goals.ts
├── plans.ts
├── tasks.ts
└── presentation.ts
```

Tool 是 DSH Agent 到 PlannerService 的适配器，只负责：

1. 模型可见的名称、描述和参数 Schema；
2. 从 `exec.agent` 获取当前 Session 身份；
3. 把参数转换为 Service Command；
4. 返回符合 Output Schema 的结构化值；
5. 用 `render()`生成模型可读摘要；
6. 必要时用 Tool Presentation 提供通用卡片。

Tool 不直接访问 Repo，也不调用 `ctx.llm`。

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
  → PlannerService Command / Query
  → HTTP 状态与 JSON Response
```

Route 不再直接调用 `listTasks()`、`updateTasks()` 或容量函数。

面向日历的主要查询：

- 正式月份视图；
- 某日正式任务；
- 当前 Session 的活跃 Proposal；
- 某 Proposal 在指定月份的服务端 Diff；
- Proposal 确认、取消修改、彻底放弃。

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
```

`planner-model.ts` 管理：

- 当前月份和选中日期；
- 正式日历视图；
- 当前 Session 的活跃 Proposal；
- Proposal revision；
- 加载、失效、确认和取消；
- Host 变更后的统一刷新。

React 组件只订阅 Client Model 并渲染，不自行计算正式数据与 Proposal Diff。

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

## 4. 提案模型

PlanProposal 是工作流对象，不是正式业务层级。

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

### 4.1 完整快照语义

- `baseline` 创建后不可变，表示提案开始时的正式状态；
- `candidate` 始终保存当前完整提案快照；
- 每次阶段提交用 `expectedRevision` 做 compare-and-set；
- V2 第一版不保存每个历史 revision，只保存最新版本；
- `validation` 保存当前版本的结构化校验结果；
- Agent 得到的是当前阶段所需的裁剪上下文，GUI 按月份读取服务端 Diff。

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
- 修改 ready 提案时先回到相应阶段并增加 revision，旧预览立即失效。

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

Host 根据 `baseline + candidate` 计算 Diff。Client 不重复实现对象匹配。

Preview 的月份查询只返回当前视口需要的数据：

- 正式未变化任务；
- `added`；
- `removed`；
- 同一正式任务的属性变化按一条 removed + 一条 added 展示；
- candidate 状态下的每日新容量。

commit 的固定顺序：

```text
检查 Proposal id / owner / revision / ready
  ↓
BEGIN IMMEDIATE
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
├── host/
│   ├── planner-service.ts
│   ├── repository.ts
│   ├── sqlite-repository.ts
│   ├── schema.ts
│   ├── prompt.ts
│   ├── routes.ts
│   └── tools/
└── client/
    ├── index.tsx
    ├── api.ts
    ├── planner-model.ts
    ├── PlannerView.tsx
    ├── ProposalPreview.tsx
    └── components/
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
2. 超容量和超过截止日期是否允许用户 override；
3. `decision_required` 的具体结构和 GUI 表达；
4. 阶段、任务数量阈值；
5. required 依赖是否允许安排在同一天；
6. Proposal 的默认过期策略；
7. ready 后用户要求修改时，是复用同一 Proposal id 还是创建 successor；
8. 是否在第一版引入独立 DSH Subagent Reviewer，还是先由当前 Agent 自检并通过 Eval 判断效果。

这些决策确认前可以完成旧行为测试和纯架构边界重构，但不能开始最终 Tool Schema 与 staged flow 实现。
