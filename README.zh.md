# perse-proof

[![CI](https://github.com/persevere-dsh/perse-proof/actions/workflows/ci.yml/badge.svg)](https://github.com/persevere-dsh/perse-proof/actions/workflows/ci.yml)

**让 DSH 的每一句「已完成 / 已验证」都有据可查，且判据不能被它自己偷偷改。**

这不是"让模型更聪明"的插件，而是把**可机械验证的部分强制掉**：哈希、存在性、退出码、追加语义、角色分离、结构不变量。它是 host 平面插件（无客户端 UI、无 typed remote），纯 ESM JavaScript、零运行时依赖。

`perse` = persevere。本仓库属于 **Persevere with DSH** 合集。

---

## 一、能力清单

| 层 | 名称 | 做什么 | 默认 |
|---|---|---|---|
| **A** | 证据闸门 | 判据冻结（内容摘要剔除易变量）＋判据漂移检测（含「失败之后被改」标记）＋ claim↔证据机械对账（文件 sha256 / 命令退出码与会话真实记录交叉核对）＋完成声明闸门＋代号闸门 | **开** |
| **B** | 汇报契约 | 注册系统提示词段 `proof:report-contract`（`order = 2900`，即 `SECTION_ORDERS.TOOL_REPORT`）：先结论后细节、禁止未释义代号、任何"已完成"必须能指到文件或命令、数字必须有出处 | **开** |
| **C** | 预算漂移 | 按轮成本观测（token / 工具调用 / 新产物 / 台账变更）＋连续无进展告警＋派发预算核对（只记录不阻断） | **默认关闭** |

持久状态只追加不覆盖：`$PERSE_PROOF_HOME/<sessionId>.jsonl`（默认 `~/.dsh/proof/`），每行 `{ts, type, data}`；坏行跳过并计入计数，写失败只告警、**绝不让插件抛错影响会话**。

## 二、9 个工具

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `proof_fact_set` | `key`(必填) `value`(必填) `evidence` `note` | 登记一条事实；文件证据校验存在性 + sha256，对不上就拒绝写入并给出实际值 |
| `proof_facts` | `key`(可选) | 读回本会话事实台账 |
| `proof_criteria_freeze` | `criteria`(必填) `taskId` `executor` `artifacts` | 冻结判据；摘要对绝对路径 / `/tmp/xxx` / `run-\w+` / 端口 / 时间戳 / `sha256:` 片段做归一化 |
| `proof_criteria_amend` | `taskId` `criteria`(必填) `reason`(必填) | 改判据必须给原因；发生在一次失败之后会被单独标记 |
| `proof_criteria_check` | `taskId` | 只读：当前第几版、改过几次、哪几次改在失败之后 |
| `proof_verify_run` | `taskId` `command` `executorPath` `exitCode` `pass` `fail` `skip` `outputSha256` | 登记一次判据运行；判据在两次运行之间被改过 ⇒ 产出 `criteria-drift`（带 `afterFailure`） |
| `proof_allowlist_add` | `file`(必填) `pattern`(必填) `reason`(必填) `failureRef`(必填) `upstreamId` `reviewBy` | 登记"放宽"；缺原因或缺对应失败引用即报错，对抗无时间界的永久放宽 |
| `proof_claim` | `claim`(必填) `level`(verified/partial/unverified) `evidence`(必填) `scope` | `verified` 必须有真实文件（含 sha256）或本会话真实跑过的命令（含退出码）；纯人工说明不能算已验证 |
| `proof_claims` | — | 列出本会话全部结论与核对结果 |

斜杠命令：

```
/proof status            一句话总览（判据 N 个任务 / 台账 M 条 / 证据 K 条 / 告警 J 条）＋告警明细 top 10，无告警时明说"无"
/proof facts [名字]      事实台账（可只看一条）
/proof criteria [任务名]  判据冻结版本与改动记录
/proof claims            结论与核对结果
/proof alerts            只看告警
/proof help              说明
```

## 三、配置项（默认值即推荐值）

```js
{
  report:   { enabled: true,  order: 2900, maxGatesPerTurn: 1 },   // B 汇报契约 + 闸门共享配额
  jargon:   { enabled: true,  minCodenameCount: 2, extraPatterns: [] },
  claims:   { enabled: true,  gateOnCompletionClaim: true,
              strictCommandEvidence: true, allowUnmatchedCommands: false },
  criteria: { enabled: true,  driftDetect: true, requireAmendReason: true,
              normalizeVolatile: true },
  ledger:   { enabled: true,  todoDropDetect: true, writeAmplifyThreshold: 8 },
  budget:   { enabled: false, noProgressRounds: 3, dispatchBudgetCheck: true,
              tokenAlerts: false },                                  // C 默认关闭
}
```

| 配置 | 默认 | 含义 |
|---|---|---|
| `report.enabled` | `true` | 是否注册汇报契约提示词段 |
| `report.order` | `2900` | 提示词段顺序（`getSectionOrder('TOOL_REPORT')` 取不到时回退这个字面量） |
| `report.maxGatesPerTurn` | `1` | 两条闸门**共享**的单轮干预上限 |
| `jargon.enabled` | `true` | 是否启用未释义代号闸门 |
| `jargon.minCodenameCount` | `2` | 一条消息里至少几个未解释代号才干预 |
| `jargon.extraPatterns` | `[]` | 追加的代号正则（字符串或 `RegExp`） |
| `claims.enabled` | `true` | 是否启用 claim 对账 |
| `claims.gateOnCompletionClaim` | `true` | 是否启用完成声明闸门 |
| `claims.strictCommandEvidence` | `true` | 命令证据是否必须与会话真实记录一致 |
| `claims.allowUnmatchedCommands` | `false` | 找不到对应记录时是否允许降级为"部分验证" |
| `criteria.enabled` | `true` | 是否启用判据冻结/漂移检测 |
| `criteria.driftDetect` | `true` | 是否在两次运行之间比对判据摘要 |
| `criteria.requireAmendReason` | `true` | 修改判据是否强制填原因 |
| `criteria.normalizeVolatile` | `true` | 是否对判据做易变量归一化 |
| `ledger.enabled` | `true` | 是否启用事实台账 |
| `ledger.todoDropDetect` | `true` | 是否检测"上一轮未完成的待办凭空消失" |
| `ledger.writeAmplifyThreshold` | `8` | 同一路径重写次数达到该值报一次写放大 |
| `budget.enabled` | `false` | C 层总开关 |
| `budget.noProgressRounds` | `3` | 连续多少轮无新产物/无台账变更算无进展 |
| `budget.dispatchBudgetCheck` | `true` | 是否核对派发声明预算 |
| `budget.tokenAlerts` | `false` | 是否在 token 用量上告警 |

## 四、安装

本包声明了 `dsh.bundle.patch` → 包内 `cordis.patch.yml`，所以 **`dsh plugin add` 会自动把它挂成 profile 的一层**：

```bash
cd perse-proof
npm pack                                   # → perse-proof-0.1.0.tgz
dsh plugin --profile web add perse-proof-0.1.0.tgz
```

`dsh plugin` 是 pnpm 转发器：它把包装进 `~/.dsh/profiles/web/node_modules`，并**只**因为包声明了 `dsh.bundle` 才把 `perse-proof` 追加进 profile `package.json` 的 `dsh.profile.bundles`（自动挂载）。

验证：新开一个会话，工具表里应出现上表 9 个工具，`/proof status` 可用；`/proof status` 在没有任何记录时应显示"无告警"。

> ⚠️ **不要**手工往 profile 的 `cordis.patch.yml` 里再插一行 `- insert: {id: perse-proof, name: perse-proof}`。
> bundle 层与手工 insert 行是"二选一"关系：两条同时存在会撞 loader 唯一 id（R-07），而且写错 `name:` 会**静默失败、零诊断**。bundle 路线不需要编辑任何 profile 补丁文件。
> （只有在包**没有** `dsh.bundle` 时才需要手工 insert 行——本包不需要。）

### 影子验证（不碰正在运行的 3080）

```bash
node scripts/verify-load.mjs --dry     # 只打印将要执行的命令
node scripts/verify-load.mjs           # 隔离 DSH_HOME + 端口 ≥3199：pack → add → 启动 → 断言 → 彻底清理
```

脚本用**隔离 `DSH_HOME`**（`/tmp/...`）和 **≥3199** 的端口启动 web profile，断言自动挂载、组合树、启动成功与工具注册，结束时 kill 进程并确认端口释放。真实 GUI 占用的 **3080 绝不被触碰**（传 `--port 3080` 会被直接拒绝）。

## 五、测试

```bash
node test/run-all.mjs      # 顺序跑 T1–T14，逐条 PASS/FAIL + 汇总，任一失败即非零退出
node scripts/pack-check.mjs # npm pack --dry-run --json，校验产物清单与挂载前提
```

测试全部用 `node:test` + `node:assert/strict`，**零依赖、离线可跑**，不依赖真实 DSH 实例，并且用 `PERSE_PROOF_HOME` / 临时目录隔离，测后清理。

## 六、Known Limitations（一条都不美化）

1. **判据写得够不够（语义充分性）管不了。** 判据文本是否真的覆盖了要保证的事情，本插件无法判断。
2. **"A 层证据能否支撑 B 层结论"管不了。** 它只能核对哈希/存在性/退出码这些机械事实，不能判断证据与结论之间的推理是否成立。
3. **命名单义性管不了。** 它只能要求面向用户的回复里把代号翻译成白话，不能保证名字本身起得对。
4. **范围扩张是否正当管不了。** budget 模块只做观测，不阻断、不裁决。
5. **"还不知道要验什么"（端到端覆盖面发现）管不了。** 本插件只能保证**你写下来的判据不被偷偷改**，不能替你发现你没想到要验的地方。
6. **本插件是观测 + 闸门，不替代人做验收决定。** 它不会、也不应该替你签字。

## 七、实现说明：纯 JS 零依赖，以及与 perse 系列 TS 规范的偏离

- **语言/构建**：v1 是**纯 ESM JavaScript，无构建步骤，零运行时依赖**（只用 `node:` 内置模块）。
- **为什么偏离**：本机正在运行的第三方 host 插件 `dsh-zai-search-tools` 就是这个形态且在 DSH rc.2 上工作正常；这样可以直接跳过 `tsc` / `tsdown` / typert 三个工具链风险点；typert 只对 typed remote 必需，而本插件没有客户端半。
- **诚实的差异**：本仓库**不符合** `perse-updater` / `perse-cua` 那套 TypeScript + `tsc -b` + `tsdown` 的规范。它没有 `lib/types/*.d.ts`、没有 `src/`、没有构建脚本。
- **后续计划**：等接口稳定后（判据/证据的数据模型不再变）再迁移到 TS，并补上类型声明与打包链；迁移时保持 `lib/index.js` 的三个导出（`name` / `apply`，不导出 `Config`）与配置文件仓库格式不变。
- **profile 依赖前提**：DSH profile 是 `autoInstallPeers:false`，所以本包**零依赖、零 peer**。

## 八、文档（Documentation）

| 文档 | 是什么 |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | 实现规格 v1——设计意图、数据模型、测试矩阵 |
| [`docs/ADDENDUM-A.md`](docs/ADDENDUM-A.md) | 绑定性修正 + 接口冻结；与 `SPEC.md` 冲突处一律以它为准 |
| [`docs/API-NOTES.md`](docs/API-NOTES.md) | **rc.2 API 实测笔记**——依据已安装的 rc.2 包实测（不是 alpha 源码），是实现的依据 |

这三份是维护者文档：留在 git 仓库里，**不进 npm 包**（`files[]` 只发布 `lib/`、`cordis.patch.yml`、`README.md`、`README.zh.md`；`LICENSE` 由 npm 自动带上）。

## 九、与本合集规范的差异（Deviations from the collection standard）

本插件是纯 ESM JavaScript、零依赖，所以合集规范里的 TS / codegen 各项**不适用**。以下只陈述事实与理由，每条一句（更长的理由见第七节）：

1. **纯 JavaScript，没有 TS / `tsconfig.json`。** 没有 `src/`、没有类型声明、没有编译步骤——`lib/` 就是源码。
2. **没有 typed remote，因此没有 codegen，也没有 `scripts/gen-typert.mjs`。** typert 只用于把 `@Remote` 方法暴露给客户端半；本插件是 host-only，没有客户端半。
3. **`lib/` 是源码、不是构建产物，所以提交入库**——与规范里"`lib/` 不入库"不同。构建产物入库才是错的，源码入库是必需的。
4. **CI 跑的是语法检查 + 测试，而不是 typecheck / codegen / build / test。** 没有编译器、没有构建步骤，前三项无事可做。
5. **测试目录为 `test/`，用 `node test/run-all.mjs` 运行**——自定义 runner，逐条打印 PASS/FAIL 矩阵，不是 `node --test`。

---

Part of Persevere with DSH
