# Personal Planner · DSH 插件

把长期目标拆成阶段与每日任务，带容量校验与语义评审，数据存在本地 SQLite。

## 安装

需要 DeepSeek Harness（Node 24+）。

```powershell
# 本地目录安装（推荐开发时）
dsh plugin --profile desktop add "D:\path\to\planner"
```

也可以在用 DSH 界面的「添加插件」里直接填本地目录路径。

装好后：

- 输入框下方出现徽章「今日 150/240 分钟」；
- 有消息的会话标题行下面多出 `Chat | 计划` 标签，点「计划」开月历面板。

## 工具（给模型用）

| 工具 | 作用 |
|---|---|
| `planner_goal_create` | 建目标（标题、动机、截止日） |
| `planner_plan_propose` | 提交计划草稿并做校验（不写正式表） |
| `planner_plan_commit` | 用户确认后把草稿落库 |
| `planner_task_query` | 按日期区间查任务 |
| `planner_task_update` | 批量改任务（单事务，失败整批回滚） |
| `planner_plan_overview` | 目标进度 + 每日负载 + 风险 |

约定：**没落库就不算创建**；容量不合规（单日超载、目标整体来不及、或语义评审 fail）不得提交。

## 校验分三层

1. **参数校验**：`defineTool` 的 schema，非法参数直接拒绝；
2. **容量校验**：单日是否超容量、任务是否超过 120 分钟、截止日前总容量是否够；
3. **语义评审**（可选）：让模型检查目标覆盖、粒度、顺序，输出问题清单。

第三层默认关闭，配置后开启：

```yaml
- id: planner
  name: "@local/planner"
  config:
    judge:
      provider: deepseek-official
      model: deepseek-flash
      timeoutMs: 8000
```

评审超时或输出不合约时降级为 `unverified`，不会阻塞提交。

## 数据

- 默认 `~/.dsh/personal-planner/planner.sqlite`（`config.dbPath` 可覆盖）；
- WAL + `busy_timeout`，`user_version` 管迁移；
- 容量规则存在 `setting` 表里，在面板的 ⚙ 里改，不进配置文件。

## 开发

```powershell
npm install
npm test        # 纯逻辑单测（planning / repo / judge）
npm run check   # tsc --noEmit
npm run build   # tsc + esbuild 打包客户端
```

结构：

```
src/
├── index.ts        插件入口：开库 → 工具 → 路由 → 释放
├── tools.ts        六个 defineTool
├── planning.ts     容量校验（纯函数，可单测）
├── judge.ts        语义评审（模型调用注入，可单测）
├── types.ts        领域类型
├── db/schema.ts    建表与迁移
├── db/repo.ts      SQL 读写
├── api/http.ts     回环围栏与响应工具
├── api/routes.ts   面板接口
└── client/         月历面板（React，注册进宿主 Slot）
```

## 已知限制

- 目标级容量只校验“总额够不够”，不做跨天均衡；
- 面板不支持拖拽改期（M4）；
- 未排期任务只能在面板底部「未排期」区排期，不能直接编辑标题；
- Judge 需要显式配置 provider/model，未做“自动用会话默认模型”。
