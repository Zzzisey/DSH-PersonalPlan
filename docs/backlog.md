# Backlog

> 待办清单。状态：`todo` / `doing` / `done` / `dropped`。
> V2 设计见 `NEW_PLANNING_FLOW.md`、`ARCHITECTURE_V2.md`、`MIGRATION_V2.md`；这里只列"还没做的事"和已知瑕疵。
> 最近更新：2026-11-05

## P0 · 承诺了但没做到

### B1. `apply_reschedule` 要真的挪任务
- **现状**：`plan_commit` 接受 `decision: "apply_reschedule"`，但只写了一条 `check_log`，**没有移动任何任务**。用户以为"按建议挪动"，实际还要再 propose 一次。
- **要做什么**：commit 时**让模型按语义提议**怎么挪（哪条、挪到哪天、为什么），算数只做护栏校验（日期窗口、P0 不动、目标日不超容量）；通过后在事务内按新日期落库，返回与 `check_log` 都记录移动明细。
- **验收**：11-05 排 300/240、11-06 只有 60/240 时，选择 `apply_reschedule` 后模型提议、校验通过、11-05 降到 ≤240、返回里列出「哪条 → 哪天（原因）」。
- **状态**：doing（代码完成：`src/reschedule.ts` + commit 分支 + 6 个单测；待装进 DSH 实测）

## P1 · 体验与可信度

### B2. 面板目标行加「完成 / 放弃」按钮
- **现状**：`planner_goal_update` 已有，但只能通过对话调用；废弃目标会一直挂在面板和 overview 顶部。
- **要做什么**：目标行右侧两个按钮 → `PATCH /api/goals` → 走 `updateGoal`；完成后该行淡出/隐藏。
- **验收**：点「放弃」后目标从 `listGoals('active')` 消失，任务仍在。
- **状态**：todo

### B3. 被 override 的日期加标记
- **现状**：用户"接受超载"后，日历上看不出这天是确认过的，下周会以为数据错了。
- **要做什么**：`/api/month` 返回每天 `overridden: true`（来自当天最近一条 `check_log.kind=override`），格子里显示小圆点，点开显示原因。
- **验收**：接受一次超载后，该日格子有标记且能看到 `reason`。
- **状态**：todo

### B4. 面板支持编辑任务标题 / 预估
- **现状**：只能勾完成、挪一天；改内容必须回对话。
- **要做什么**：任务行双击进入内联编辑（标题、分钟），保存走 `PATCH /api/tasks`。
- **验收**：改完刷新后仍生效，且当日负载随之更新。
- **状态**：todo

### B5. 工具层 e2e 测试
- **现状**：32 个测试只覆盖 `planning` / `repo` / `judge` 纯逻辑；工具层（propose→commit、HITL、回滚）靠手测。
- **要做什么**：内存库 + `createPlannerTools`，直接调各工具的 `execute`，覆盖：正常落库、`needs_decision` 拒绝、带 decision 通过、`invalid` 拒绝、整批回滚。
- **验收**：`npm test` 里新增一组 `tools.test.ts`，不依赖 DSH 宿主。
- **状态**：todo

## P2 · 里程碑内未完成

### B6. 拖拽改期（M4）
- 把任务从一天拖到另一天，落库走 `PATCH /api/tasks`。
- **验收**：拖到超载日时提示，但不阻止（与 HITL 一致）。
- **状态**：todo

### B7. 键盘切月 / 跨月连续视图（M4）
- `←/→` 切月，`J/K` 切日期；跨月边界保持选中日连续。
- **状态**：todo

### B8. 跨天均衡（M2 遗留）
- 现在只报"哪天超了"，不会摊平。要做什么：propose 时给出"把这些任务从 X 挪到 Y"的建议清单（不自动执行，作为选项目）。
- **状态**：todo

## P3 · 讨论过、暂不排期

- 通知 / 提醒（每日待办、面试前一晚）；
- 周报 / 月报自动生成；
- 依赖顺序的**确定性**校验（现在只有 Judge 语义提示）；
- 目标模板（"两周面试冲刺"一键生成）；
- 多目标之间的容量竞争。

## 已知瑕疵（不是新功能，是需要修的口径问题）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| K1 | `ctx.llm.stream` 的 `system` 参数位置靠适配器容忍 | 换个宿主可能拿不到文本 | 对着真实签名验证一次 |
| K2 | `plan_overview` 的目标进度按查询区间统计 | 跨区间的历史任务不计入，进度会偏高 | 改成按目标全量统计 |
| K3 | `check_log` 只在 propose / commit 写入 | `overview`、`task_update` 的改动无痕 | 视需要补 `task_update` 审计 |
| K4 | 迁移只有向前（v1→v2） | 无回滚路径 | 加 `PRAGMA user_version` 降级检查与提示 |
| K5 | 并发假设"单写进程" | 多开实例靠 `busy_timeout` 兜底 | 文档写明，或加进程锁 |
| K6 | Judge 默认关闭 | 语义问题（目标覆盖、顺序）不会被发现 | 保持默认关，但 README 里给一句话指引 |

## 工程与开源

| 项 | 状态 | 备注 |
|---|---|---|
| CI 在 GitHub 上真跑一次 | todo | `.github/workflows/ci.yml` 已写，仓库未推 |
| LICENSE 文件 | todo | README 声明 MIT，仓库缺文件 |
| 截图 / 演示 GIF | todo | 面板与对话各一张 |
| 发布流程（GitHub Release 挂 tgz 或 npm） | todo | 版本号目前 0.1.0 |
| V2 设计文档入库 | done | 业务流程、架构和迁移计划已进入独立文档分支，等待评审 |
| 客户端单元测试 | todo | `usePlanner` 的乐观更新与回滚逻辑值得测 |
