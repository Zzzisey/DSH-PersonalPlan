# STATE · 当前实际状态

> 这份文件描述**代码和数据库里现在真实存在的东西**，不是设计意图（那在仓库外的 `DESIGN.md`）。
> 每次功能改动后同步更新。最后核对：2026-11-06，核对方式：直接读 DDL + 查询真实库。

## 1. 数据表（SQLite，`~/.dsh/personal-planner/planner.sqlite`）

schema 版本 `user_version = 2`。

| 表 | 用途 | 关键字段 |
|---|---|---|
| `goal` | 长期目标 | `id, title, motivation, deadline, status(active/done/dropped), created_at, updated_at` |
| `phase` | 阶段（里程碑） | `id, goal_id, title, seq, start_day, end_day, status(planned/active/done/dropped)` |
| `task` | 任务（叶子） | `id, goal_id, phase_id, title, day, est_minutes, actual_minutes, priority(P0/P1/P2), status(todo/doing/done/dropped), note` |
| `draft` | 计划草稿 | `id, goal_id, mode(new/adjust), payload_json, verdict, status(open/committed/discarded), created_at, expires_at, decision_required, options_json` |
| `check_log` | 校验与破例日志 | `id, at, kind(capacity/semantic/commit/override), target, verdict, issues_json, model` |
| `setting` | 键值设置 | `key, value, updated_at`（目前只有 `capacity`） |

层级只有三层：`goal → phase → task`。**任务没有子任务**，`task` 是叶子。

## 2. 工具（7 个）

| 工具 | 参数（* 必填） | 行为 |
|---|---|---|
| `planner_goal_create` | `title*, motivation, deadline` | 建目标 |
| `planner_goal_update` | `goal_id*, status?, title?, motivation?, deadline?`（空串 = 清除截止） | 改目标记录，**不删任务** |
| `planner_plan_propose` | `goal_id*, phases[], loose_tasks[], draft_id?, mode?` | 写草稿 + 容量校验 + 语义评审，不碰正式表 |
| `planner_plan_commit` | `draft_id*, decision?, reason?` | 落库；`decision ∈ accept_overload / apply_reschedule / shrink` |
| `planner_task_query` | `from?, to?, goal_id?, status?, limit?`（默认 7 天、50 条） | 只读查任务 |
| `planner_task_update` | `updates[]`（≤20，每条 `id*` + 可改字段） | 单事务批量改，任一条非法整批回滚 |
| `planner_plan_overview` | `from?, to?, goal_id?` | 目标进度 + 每日负载 + 风险 |

`phases[].tasks[]` 字段：`title*`、`est_minutes*`（1–120）、`day`、`priority`、`note`。
`est_minutes` 超过 120 触发 `task-too-big` 警告；不填会被工具拒绝。

### 结论词表

内部四档：`ok` / `warn` / `needs_decision` / `invalid`；入库时映射为
`pass` / `warn` / `fail` / `unverified`（DB 的 CHECK 约束沿用旧词表）。

| 结论 | 含义 | 能否提交 |
|---|---|---|
| `ok` | 无问题 | 可以 |
| `warn` | 接近上限（≥85%）、任务 >120 分钟、语义告警 | 可以 |
| `needs_decision` | 单日超容量、整体来不及、截止已过、语义 fail | 必须带 `decision` |
| `invalid` | 单日 >2 倍容量或 >12 小时 | 拒绝 |

## 3. HTTP 接口（5 个，前缀 `/personal-planner/api`，仅回环）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/ping` | 连通性探针 |
| GET | `/month?month=YYYY-MM` | 42 天日历 + 目标 + 容量 + 未排期任务 |
| GET | `/day?day=YYYY-MM-DD` | 单日任务与负载 |
| PATCH | `/tasks` | 改任务（day/status/est_minutes/priority） |
| PUT | `/capacity` | 写容量规则（工作日/周末/按日覆盖） |

## 4. 界面现在能做什么

| 位置 | 能力 |
|---|---|
| 输入框下方徽章 | 显示「今日 X/Y 分钟」，超载变色；**不自动刷新**（需重载页面） |
| 会话「计划」标签 | 月网格（负载条 + 今天描边）、点日期看清单、勾选完成、`[明天 →]` 挪一天、目标进度行、⚙ 容量编辑、底部「未排期」区（可排到选中日） |

**界面上看不到的**：阶段（phase）、草稿（提交前无预览）、override 标记、任务标题/备注的编辑。

## 5. 库里的数据（2026-11-06）

| 目标 | 状态 | 截止 | 阶段 | 任务 |
|---|---|---|---|---|
| 弄透简历 + 推进科研（11-05 ~ 11-12） | active | 2026-11-12 | 2（简历 41 / 科研 12） | 53 |
| 拿下 11-03 晚上的 AI 应用/Agent 岗面试 | active | 2026-11-03（已过） | 3 | 12 |
| 验证目标级容量（可删） | dropped | 2026-11-05 | 1 | 1（已 dropped） |

容量设置：`weekdayMinutes=600, weekendMinutes=600, overrides={2026-11-07:180, 2026-11-10:240}`。

当前计划负载：11-05 450 · 11-06 495 · 11-07 150/180 · 11-08 480 · 11-09 480 · 11-10 180/240 · 11-11 480 · 11-12 495。

其他计数：草稿 8（多为历史）、`check_log` 35、`setting` 1。

## 6. 已知缺口（不是待办愿景，是现在就能观察到的缺失）

1. 阶段在界面上不可见；
2. 草稿无法预览，提交前只能看对话；
3. 徽章不自动刷新；
4. 面板不能编辑任务标题/预估，也不能拖拽改期；
5. `apply_reschedule` 的代码已实现（模型提议 + 算数护栏），**但真实流程还没验证过**；
6. 工具层/接口层/客户端没有自动化测试，只有 `planning` / `repo` / `judge` / `reschedule` 的 38 个纯逻辑测试。

## 7. 自查命令

```powershell
cd D:\找工作\manage_with_ai\personal-planner\planner
npm test          # 38 个用例
npm run check     # tsc --noEmit
npm run build     # tsc + 打包客户端
git log --oneline # 提交历史
```

查库（临时脚本）：用 `node:sqlite` 打开 `~/.dsh/personal-planner/planner.sqlite`，
`select * from goal` / `phase` / `task` / `draft` / `check_log`。
