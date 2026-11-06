# HANDOFF · 交接说明

> 给接手的开发者（人 / AI）。仓库：`D:\找工作\manage_with_ai\personal-planner\planner`（Node 24 + TypeScript，SQLite）。
> 先读 `docs/STATE.md`（现在有什么），再读本文（卡在哪、下一步做什么）。
> `DESIGN.md` 在仓库外（`personal-planner\DESIGN.md`），是设计意图，不是现状。

## 一、当前完成到哪

- 插件可用：7 个工具、5 个接口、月历面板、徽章；数据在 `~/.dsh/personal-planner/planner.sqlite`（schema v2）。
- 质量校验：容量（单日 / 目标级）、语义评审（Judge，60s 超时）、HITL 四档结论（ok / warn / needs_decision / invalid）。
- 测试：38 个纯逻辑用例（planning / repo / judge / reschedule），`npm test` 全绿。
- 最近提交：`d0afb18 docs: add STATE.md`。

## 二、真正卡住的三件事

### 卡点 1：goal / phase / task 没有正式定义（最根本）

现在只有表字段，没有"什么算一个合法 goal/phase/task"的契约。后果：

- 校验器无法检查结构（只检查单条任务的时长和日期）；
- Judge 只能凭感觉（提示词里没有标准，输入里也没有阶段树）；
- 界面无法表达 phase（它没有含义可展示）；
- 我（上一个 AI）可以把两个结果塞进一个 goal、把 41 条任务塞进一个 phase，而所有校验都显示 `ok`。

**需要产出**：`docs/CONTRACT.md`，每条写成可机械判定的谓词 + 反例。草案要点：

```
goal：单一结果 + 可验收 + 有完成事件 + 不与其它 goal 结果重叠
phase：单主题 + 有 acceptance（做完什么算完成）+ 3..8 个 task + 时间窗覆盖其任务
task：单动作 + 有可见产出 + ≤120 分钟 + 落在某一天
维持类（力扣/健身）：不进 phase，放 loose_tasks
```

实现落点：`src/planning.ts` 新增 `checkStructure(goal, phases, tasks)`，每条谓词一个单测；反例直接用本次的"41 条大桶"当 fixture。

### 卡点 2：三阶段提案未实现

设计已定，代码没动。现在 `est_minutes` 必填、`day` 可选，一次调用就产出完整计划，导致"标题和估时同时生成"，估时被标题模糊性带偏（例：「写自我介绍」拍成 60 分钟）。

目标契约：

| est_minutes | day | 阶段 | 校验 |
|---|---|---|---|
| 全缺 | 全缺 | 一：列事件 | 粒度 + 结构 |
| 全有 | 全缺 | 二：估时 | 单条 15–120、太细提示合并 |
| 全有 | 全有 | 三：排期 | 容量 + Judge |
| 混合 | — | 报错 | 要求补齐 |

`plan_commit` 在缺时长或缺日期时拒绝。

**注意**：`src/index.ts` 里的 systemPrompt 仍是旧文案（还写着"容量 fail 不允许提交"），新版已起草但**依赖三阶段落地**，先实现再改提示词，否则提示词描述的流程和工具行为不一致。

### 卡点 3：界面看不见结构（用户失控感的来源）

- phase 不渲染；草稿无预览；override 无标记；任务标题/预估不可编辑。
- 结果：53 条任务落库后，用户只能从对话里看清单，无法自己核对，于是觉得"项目失控"。

**最小修复**：`GET /api/month` 带回 phase 维度（或新增 `GET /api/structure`），面板加"按阶段看进度"；草稿加预览（`GET /api/drafts/:id`）。

## 三、已决策但未落地的迁移

把合并目标「弄透简历 + 推进科研」拆成两个 goal（简历 / 科研），并把现有 53 条任务迁过去。

- 阻塞点：`planner_task_update` **不能改 `goal_id` / `phase_id`**；
- 两条路：a) 重新 propose 两个目标、旧任务标 dropped；b) 给 task_update 加 `goal_id`/`phase_id` 字段后直接搬（推荐，以后也用得上）。
- 所有任务目前都是 `todo`，搬迁不会丢完成状态。

## 四、已知缺陷（不影响主流程，但会咬人）

1. `apply_reschedule` 的代码实现了（模型提议 + 算数护栏），**但真实流程从未触发验证**；
2. Judge 偶发 `模型未返回文本（finish=[object Object]）`——诊断信息把对象直接插进字符串，改用 `JSON.stringify` 即可；
3. `plan_overview` 的目标进度只统计查询区间内的任务，跨区间会失真；
4. `check_log` 只在 propose/commit 写入，`task_update` 无审计；
5. 无工具层 / 接口层 / 客户端测试；发现过的 bad case（训练前没 sanity、阶段大桶）没有固化成 fixture；
6. 旧数据：`g_a911a669`（面试已过）仍 `active`，12 条过期任务；`g_bfda5fb5` 已 dropped 但留 1 条任务。

## 五、环境与协作注意事项

1. **改完必须彻底退出 DSH 再启动**（托盘退出，不是关窗口）。进程比 `dist` 旧时会表现为 `unknown tool "planner_plan_propose"`；
2. **不要用 PowerShell 的 `Set-Content`/`-replace` 批量改中文源码**——会破坏编码（曾因此提交过坏文件，靠 `git checkout` + `--amend` 修复）。用编辑工具按行改；
3. 插件 HTTP 端口随实例变化（`GET /personal-planner/api/ping` 可用于探测），不要写死；
4. 数据库可直接用 `node:sqlite` 读写；容量存在 `setting.capacity`，改完立即生效（每次写入现读）；
5. 提交流程：`npm test` → `npm run check` → `npm run build` → `git commit`；设计文档在仓库外，不入库。

## 六、建议的接手顺序

1. 写 `docs/CONTRACT.md`（人审）→ 实现 `checkStructure` + 用本次坏例子做 fixture；
2. 实现三阶段（`est_minutes`/`day` 可选 + 粒度检查 + commit 拒绝缺项）；
3. 更新 systemPrompt（按三阶段写，含正反例）；
4. 拆 goal 迁移（给 task_update 加 goal_id/phase_id）；
5. 面板：阶段进度 + 草稿预览；
6. 验证 `apply_reschedule` 真实链路。
