# perse-proof · 实现规格 v1（A+B+C 全量）

> 一句话定位：**让 DSH 的每一句"已完成/已验证"都有据可查，且判据不能被它自己偷偷改。**
> 这不是"让模型更聪明"的插件，而是**把可机械验证的部分强制掉**：哈希、存在性、退出码、追加语义、角色分离、结构不变量。

## 0. 硬性前提（违反即返工）

1. **host 平面、无客户端 UI、无 typed remote**：单包，纯 ESM JavaScript，**零运行时依赖**（只用 `node:` 内置模块）。
   不引入 typert、不做浏览器半。挂载方式 = 装进 profile 的 node_modules + 在 profile 的 `cordis.patch.yml` 加一行（与用户现有的 `dsh-zai-search-tools` 同一模式）。
2. **`package.json` 不声明 `dsh.bundle`**（避免 host 树 / preset 树双挂导致 `apply` 跑两次、监听双份）。
3. **所有 API 必须按 `docs/API-NOTES.md`（由核实代理产出，来源 = 已安装 rc.2 包）写**；`docs/API-NOTES.md` 标"未验证"的地方，实现里必须有运行时兜底（判空、try/catch、降级日志），**不允许崩掉整个插件加载**。
4. **不允许 inject 不存在的服务**（会导致插件 pending、`app-boot` 报错）。采用防御式接线：不 inject，`apply()` 里逐个判空，缺失的能力只降级并记一条日志。
5. **一切持久状态只追加，不覆盖**：所有本插件事件都是 append-only；投影只做派生视图。
6. **副作用上限**：单轮内每个闸门最多干预 1 次（`maxGatesPerTurn`）；所有闸门都可配置关闭；`budget` 默认 `enabled: false`。

## 1. 目录与文件

```
perse-proof/
  package.json            # name=perse-proof, type=module, main=lib/index.js, files=[lib, cordis.patch.yml, README*], 无 dependencies
  lib/
    index.js              # 插件入口：name / apply(ctx, config)；防御式接线所有能力
    config.js             # 默认配置 + 合并与校验（手写，不引入 schemastery）
    ledger.js             # C3：append-only 事实台账 + todo 丢项检测 + 写放大统计
    criteria.js           # C1：判据冻结 / 变更留痕 / 漂移检测 / 白名单审计
    claims.js             # C2：claim↔evidence 机械对账（含与真实工具记录交叉核对）
    report.js             # B：TOOL_REPORT 提示词段（order 2900）+ 面向用户回复的汇报契约
    gates.js              # 闸门：完成声明闸门 + 代号闸门（都在 agent/turn-stopping）
    budget.js             # C：按轮成本/无进展检测 + 派发预算核对（默认关闭）
    digest.js             # 规范化内容摘要（剔除易变量）+ 文件 sha256
    commands.js           # /proof 命令（status/facts/criteria/claims/alerts/help）
    util.js               # 事件追加、投影注册、时间、截断等薄封装 + 能力探测
  test/
    mock-ctx.mjs          # 假 ctx（记录事件、可触发事件、可读取注入内容）
    ledger.test.mjs
    criteria.test.mjs     # 含"易变量不影响摘要"与"A-CORE 漂移场景"
    claims.test.mjs
    gates.test.mjs
    budget.test.mjs
    config.test.mjs       # 配置默认值 + 插件装配
    run-all.mjs           # 顺序跑全部测试，非零退出即失败
  scripts/
    verify-load.mjs       # 影子模式：隔离 DSH_HOME 启动，确认插件加载 + 工具注册
    pack-check.mjs        # npm pack 后校验 tgz 内容清单
  README.md / README.zh.md
  LICENSE
  docs/                 # 维护者文档：不进 npm 包，只留在 git 仓库
    SPEC.md             # 本文件
    ADDENDUM-A.md       # 绑定性修正 + 接口冻结（优先于 SPEC）
    API-NOTES.md        # rc.2 API 实测笔记（由 API 核实代理产出，实现依据）
```

## 2. 数据模型（全部 append-only）

事件类型（`data` 形状；`seq`/`time` 由框架补）：

| 事件 | data |
|---|---|
| `proof/fact` | `{key, value, evidence:[Evidence], source:'tool'\|'model', supersedes?:seq, note?}` |
| `proof/criteria` | `{taskId, revision, criteria:[{id,desc,check}], contentSha256, executor?:{path,sha256}, artifacts:[path], supersedes?, reason?, afterFailure?}` |
| `proof/allowlist` | `{file, pattern, reason, failureRef, upstreamId, reviewBy?, addedAt}` |
| `proof/claim` | `{claim, level:'verified'\|'partial'\|'unverified', scope?, evidence:[Evidence], checked:[{kind,ok,detail}]}` |
| `proof/verify-run` | `{taskId, criteriaSha, executorSha?, command?, exitCode?, pass, fail, skip, outputSha256?, at}` |
| `proof/alert` | `{kind:'criteria-drift'\|'todo-drop'\|'write-amplify'\|'claim-unbacked'\|'jargon'\|'no-progress'\|'dispatch-overrun', detail, refs:[seq]}` |
| `proof/dispatch` | `{tool, declaredBudget?, artifacts:[path], model?, at}` |

`Evidence` = `{kind:'file', path, sha256}` | `{kind:'command', cmd, exitCode, outputSha256}` | `{kind:'manual', note}`
`manual` **不能**支撑 `level:'verified'`（只能 `partial`）。

投影：`proofFacts`（key → 最新 fact）、`proofState`（`{criteria: taskId→最新, claims:[最近 N], alerts:[最近 N], counts}`）。
若投影 API 不可用 → 降级为"每次从会话事件重放"，功能不减。

## 3. 各模块行为（验收即照此写测试）

### 3.1 ledger（C3）
- `proof_fact_set({key, value, evidence?, note?})`：
  - 逐条**机械校验** `file` 证据（存在 + sha256 相符）；不符 → **工具报错**（返回错误，不写入），错误信息给出实际 sha 与期望 sha。
  - `command` 证据：见 3.3 的交叉核对规则；核对不过 → 降级为 `partial` 或报错（取决于 `claims.strictCommandEvidence`）。
  - 调用 `proofFacts` 读回时返回 `{key: {value, sha256证据, 写入时间, 来源}}`。
- **todo 丢项检测**：监听工具调用；当本次 `todo_write` 的清单里，上一版中 status 为 `pending|in_progress` 且**未变 completed** 的条目（按 content 归一化匹配）消失 → 追加 `proof/alert{kind:'todo-drop'}`，并在**下一轮开始前**注入一条模型可见提示（`"上一轮清单里这 3 项未标完成就消失了：…（如果是有意删除，请显式说明）"`）。
- **写放大统计**：按 `tool/call` 的 `name` + 目标路径统计 `read` vs `edit|write`；单路径重写次数 ≥ `writeAmplifyThreshold`（默认 8）→ 一条 `proof/alert{kind:'write-amplify'}`（同一路径同一会话只报一次）。`/proof status` 里给出 top 5。

### 3.2 criteria（C1）——本插件的核心
- `proof_criteria_freeze({taskId, criteria, executor?, artifacts?})`：
  - `taskId` 缺省由 `taskId ?? 'default'`。
  - **摘要必须是内容摘要且剔除易变量**：对 `criteria` 规范化（按 `id` 排序、trim、折叠空白）后拼接计算 sha256；
    **同时**对每条 `check` 字符串做"易变量归一化"：把绝对路径、`/tmp/xxx`、`run-\w+`、端口号 `:\d{2,5}`、ISO/RFC 时间戳、`sha256:[0-9a-f]{8,}` 替换为占位符 **再摘要**（`contentSha256` 用归一化后的文本）。
  - **执行器与判据同文件即告警**：若 `executor.path` 出现在 `criteria[*].check` 引用的文件集合里 → 追加 `proof/alert{kind:'criteria-drift', detail:'executor==criteria file'}`。
- `proof_verify_run({taskId, command|executorPath, exitCode, pass, fail, skip, outputSha256?})`：
  - 读当前 `criteria` 的 `contentSha256`；若与上一次运行时的 `criteriaSha` 不同 → 追加 `proof/alert{kind:'criteria-drift'}`，记录 `{from, to, afterFailure: 上一次运行是否有 fail>0}`。
  - **这是 A-CORE 场景的机械判定**：`freeze → run(FAIL) → 判据文件被编辑 → run(PASS)` 必须产出 `criteria-drift` 且 `afterFailure:true`。
- `proof_criteria_amend({taskId, reason, criteria})`：`reason` 为空 → 报错；写入新 revision，带 `supersedes` 与 `afterFailure`（同上机械判定）。
- `proof_allowlist_add({file, pattern, reason, failureRef, upstreamId, reviewBy?})`：`failureRef` 与 `reason` 必填（缺失即报错），用于对抗"无时间界的永久放宽"。
- `proof_criteria_check({taskId})`：只读，返回当前 revision 列表 + 每条 amendment 的 `afterFailure` 标记。

### 3.3 claims（C2）
- `proof_claim({claim, level, evidence, scope?})`：
  - `file` 证据：机械校验（存在 + sha256 相符），失败即**报错**并返回实际值。
  - `command` 证据**必须与会话里真实发生过的工具调用交叉核对**：在本会话的 `tool/call`（name=bash/pwsh）里找 `command` 包含该 `cmd` 的记录，并要求其对应 `tool/result` 的退出码/输出哈希与声明一致；找不到或不一致 → **拒绝记为 verified**（可降级为 partial，需 `allowUnmatchedCommands:true`）。
  - `level:'verified'` 且证据全为 `manual` → 报错。
- `proof_claims()`：列出本会话全部 claim 与核对结果。

### 3.4 report（B）
- 注册系统提示词段：`name:'proof:report-contract'`，`order: 2900`（若能从 API 取到 `SECTION_ORDERS.TOOL_REPORT` 用它，否则用字面量并注释来源）。
- 段文本（中文，写死，长度 ≤ 900 字，要点）：
  1. 先结论后细节；默认按「结论 / 证据 / 影响 / 下一步」四段，除非用户另有要求；
  2. **面向用户的回复里禁止出现未释义的内部代号与自造方案名词**（如 `D3`、`S6a`、`U-1-A1`、`ADJ-5`、`WP8`）；确需引用时，**首次出现必须写成"白话名称（代号）"**；
  3. 任何"已完成 / 已验证 / 全部通过"必须能指到一个已存在的文件或一条已执行的命令；给不出就改写成"未验证"；
  4. 数字必须有出处；不同来源数字不一致时，先说明口径而不是二选一；
  5. 不搬运子代理的内部汇报原文；面向用户时先翻译成白话。
- 段必须**可关闭**（`report.enabled=false`）。

### 3.5 gates（B+A 的执行面）
都在 `agent/turn-stopping`（若该钩子不可用则退化为在 `agent/pre-step` 扫描上一轮回复）：
- **完成声明闸门**：扫描本轮最终助手消息中的完成性措辞（`已完成|已经完成|全部通过|通过了|验证通过|已验证|搞定|收口完成|PASS`）。
  命中且本会话**没有**任何 `proof/claim{level:'verified'}` → 注入一次要求：要么补 `proof_claim` 证据，要么把措辞降级为"未验证/待验证"。
- **代号闸门**：扫描未释义代号：`/\b[A-Z]{1,5}-\d+[a-z]?\b/`、`/\bS\d[a-i]\b/`、`/\bWP\d+\b/`。
  规则：**同一消息内出现 ≥ `minCodenameCount`（默认 2）且没有任何一处带括号白话解释** → 注入一次要求改写成"白话名称（代号）"。
  单独一个代号、或已带解释 → 不干预。
- 两条闸门**共享** `maxGatesPerTurn`（默认 1）：一轮最多干预一次，避免把模型逼成填表机。

### 3.6 budget（C，默认关闭）
- 按轮统计：token 用量（`ctx.tokenMeter` 或 `assistant/message.usage`）、工具调用数、**新写入的产物路径数**、台账变更数。
- `noProgressRounds`（默认 3）连续轮次既无新产物路径也无台账变更 → `proof/alert{kind:'no-progress'}` + 一次注入（要求收窄范围 / 交阶段报告 / 落盘）。
- 派发核对：`subagent|workflow|ralph` 调用时从 prompt 里提取声明预算（`≤\s*(\d+)\s*次|预算上限[:：]?\s*(\d+)|maxToolCalls[:：]?\s*(\d+)`），记录 `proof/dispatch`；子代理结算后统计其工具调用数，超出即 `proof/alert{kind:'dispatch-overrun'}`（**只记录不阻断**，避免与"主代理只做编排"的授权冲突）。

### 3.7 命令 `/proof`
- `/proof status`：一行摘要（判据 N 个任务 / 台账 M 条 / 证据 K 条 / 告警 J 条）＋告警明细（top 10）；无告警时明确说"无"。
- `/proof facts [key]`、`/proof criteria [taskId]`、`/proof claims`、`/proof alerts`、`/proof help`。
- 命令输出必须**人话**：不出现本插件自己的内部字段名（用"判据/证据/台账/告警"这类中文词）。

## 4. 配置（默认值即推荐值）

```js
{
  report:   { enabled: true, order: 2900, maxGatesPerTurn: 1 },
  jargon:   { enabled: true, minCodenameCount: 2, extraPatterns: [] },
  claims:   { enabled: true, gateOnCompletionClaim: true, strictCommandEvidence: true,
              allowUnmatchedCommands: false },
  criteria: { enabled: true, driftDetect: true, requireAmendReason: true,
              normalizeVolatile: true },
  ledger:   { enabled: true, todoDropDetect: true, writeAmplifyThreshold: 8 },
  budget:   { enabled: false, noProgressRounds: 3, dispatchBudgetCheck: true, tokenAlerts: false },
}
```

## 5. 测试矩阵（`node test/run-all.mjs` 必须全绿）

| 用例 | 断言 |
|---|---|
| T1 摘要稳定性（约束#1） | 同一判据文本，仅改变 `/tmp/xxx`、端口、时间戳、`sha256:` 片段 ⇒ `contentSha256` **不变**；改变判据措辞 ⇒ **变** |
| T2 A-CORE 漂移（约束#2） | `freeze → verify_run(fail=1) → 编辑判据文件 → verify_run(pass=10)` ⇒ 产出 `criteria-drift` 且 `afterFailure=true` |
| T3 执行器同文件 | `executor.path` ∈ 判据引用文件 ⇒ 告警 |
| T4 白名单审计（约束#3） | 缺 `failureRef` 或 `reason` ⇒ 工具报错 |
| T5 todo 丢项 | 3 项 pending → 下次清单只剩 1 项 ⇒ 1 条 `todo-drop` + 生成一次注入文本 |
| T6 写放大 | 同一路径 9 次 edit ⇒ 1 条 `write-amplify`，再次触发不重复 |
| T7 claim 文件证据 | sha 不符 ⇒ 工具报错且不写入 |
| T8 claim 命令证据 | 会话里没有对应 bash 记录 ⇒ 拒绝 verified；有且输出哈希一致 ⇒ 通过 |
| T9 完成声明闸门 | 无 verified claim + "已完成" ⇒ 恰好 1 次注入；有 verified claim ⇒ 0 次 |
| T10 代号闸门 | `D8/D9/ADJ-5` 无解释 ⇒ 1 次注入；`D8（主按钮）` ⇒ 0 次；单代号 ⇒ 0 次 |
| T11 闸门配额 | 一轮同时命中两条闸门 ⇒ 总注入次数 = `maxGatesPerTurn` |
| T12 budget 关闭 | `budget.enabled=false` ⇒ 不产生任何 budget 告警（C 默认不干扰） |
| T13 能力缺失降级 | 假 ctx 缺少 `tokenMeter`/投影 API ⇒ 插件仍能加载，工具仍可用，只记降级日志 |
| T14 全关 | 所有能力 `enabled:false` ⇒ `apply()` 不注册任何工具/段/监听（干净退出） |

## 6. 交付与安装（必须两步都验证）

1. `cd perse-proof && npm pack` → `perse-proof-0.1.0.tgz`
2. `dsh plugin --profile web add <tgz>`（写 `~/.dsh/profiles/web`）
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行（与既有第三方插件行同构）：
   ```yaml
   - id: perse-proof
     name: perse-proof
   ```
4. **验证**：新开一个会话，工具表里应出现 `proof_fact_set / proof_criteria_freeze / proof_verify_run / proof_claim / proof_criteria_check / proof_claims / proof_allowlist_add`，且斜杠命令 `/proof` 可用；`/proof status` 输出"无告警"。
5. **影子模式**（隔离 `DSH_HOME` + 端口 ≥3100，绝不碰主进程 3080）：`node scripts/verify-load.mjs` 启动并断言插件加载成功、7 个工具注册成功。

## 7. README 必须写清的 Known Limitations（不许假装能解决）

1. 判据**写得够不够**（语义充分性）管不了；
2. "A 层证据能否支撑 B 层结论"管不了；
3. 命名单义性管不了（只能要求面向用户时翻译）；
4. 范围扩张是否正当管不了（budget 模块只观测）；
5. "还不知道要验什么"（端到端覆盖面发现）管不了 —— 本插件只能保证**你写下来的判据不被偷偷改**；
6. 本插件是**观测+闸门**，不替代人做验收决定。
