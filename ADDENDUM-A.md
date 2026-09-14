# perse-proof · 附录 A（绑定性修正 + 接口冻结）

> **本文件优先于 `SPEC.md`**：凡冲突处，以本文件与 `API-NOTES.md` 为准。
> `API-NOTES.md` 是实测出来的真实 API（来源：已安装 rc.2 包 + 内存探针）；`SPEC.md` 是设计意图。

## A1. 四条必须改掉的设计假设（否则会炸）

| # | SPEC 里的假设 | 真实情况 | 本插件的对策 |
|---|---|---|---|
| 1 | 用自定义会话事件（`proof/fact` 等）做追加式存储 | `session.append` **写不出 `ignorable`**（第三参被静默丢弃）；而 `dsh-session-persistence` 对不在 `KNOWN_SESSION_EVENT_TYPES` 里的类型**一律 throw** ⇒ **日志在重启后会被 rc.2 自己拒绝加载** | **不发明会话事件**。持久状态改为**文件追加**：`~/.dsh/proof/<sessionId>.jsonl`（每行一条记录），用 `node:fs` + `node:path` + `node:crypto` 直接读写 |
| 2 | 工具用 `handler` 字段、可用 `toolFilter` | `ctx.tools.register` 的字段是 **`execute(args, exec)`**，无 `handler`；`parameters` 直接吃**原始 JSON Schema**；`toolFilter` 不存在（用 `ctx.tools.restrict`） | 按真实形状写：`{name, description, parameters:<JSON Schema>, execute}` |
| 3 | 在 `agent/turn-stopping` 里读本轮助手文本、用返回值阻止结束 | payload 只有 `{agent, turn, signal}`；该事件是 **serial**，返回值被丢弃；读不到回复文本 | ① 用 `assistant/message` 已先提交的事实，**扫会话日志取最后一条 assistant 文本**（官方 `dsh-headless` 同款做法）；② 阻止结束/追加要求只能靠 **`agent.steer(msg)`** |
| 4 | 硬编码 `SECTION_ORDERS.TOOL_REPORT`，直接 `ctx.goals` / `ctx.tokenMeter` | `SECTION_ORDERS` **未导出**；`ctx.goals !== undefined` 判空**会抛错**（未 inject）；`ctx.fs` 没有 readFile/writeFile 且受沙箱策略约束 | ① 用 `ctx.systemPrompt.getSectionOrder('TOOL_REPORT')`，取不到再退回字面量 `2900`；② 可选依赖一律 **`ctx.get('goals')` / `ctx.get('tokenMeter')`**，判空用该返回值；③ 文件读写走 `node:fs`（本插件是 host 插件，进程内有完整 Node 能力） |

**其余已核实的易错点（写代码时必须照做）**
- 日志：`ctx.logger.info` 默认阈值会把 `warn/debug` 吞掉，且 DSH 无文件日志 → 诊断信息用 **`console.log("[perse-proof] ...")`**。
- 同名系统提示词段重复注册会抛错 → 注册前判重、`apply` 用 try/catch 兜住。
- `agent/turn-stopping` 里要拿 session/agent：payload 里有 `agent`，session 从 `agent.session` 取（以 API-NOTES 为准）。
- `inject` 缺失服务会让 entry 永久 pending 并让 `app-boot` 拒绝启动 → **不写 inject**，全部运行时防御式接线。
- profile 是 `autoInstallPeers:false` → **零依赖、零 peer**（唯一可选 peer 参照 perse-cua：`@deepseek-ai/cordis`；能不加就不加）。

## A2. 语言与构建（偏离用户 TS 惯例，理由是可靠性）

**v1 用纯 ESM JavaScript，无构建步骤，零运行时依赖**（只 `node:` 内置模块）。
理由：① 本机正在运行的第三方插件 `dsh-zai-search-tools` 就是这个形态且在 rc.2 上工作正常；
② 跳过 tsc/tsdown/typert 三个工具链风险点；③ typert 只对 typed remote 必需，本插件没有客户端半。
→ README 里必须写明这一点与后续迁移 TS 的计划，不要假装符合 perse-updater 的 TS 规范。

## A3. 文件仓库（替代会话事件）

```
~/.dsh/proof/<sessionId>.jsonl      # 追加写，每行 {ts, type, data}
~/.dsh/proof/<sessionId>.meta.json  # {sessionId, cwd, firstSeenAt, lastSeenAt}（可覆盖更新）
```
记录 `type` 取值：`fact` / `criteria` / `allowlist` / `claim` / `run` / `alert` / `dispatch` / `turn` / `toolcall` / `steer`。
- 只用 `fs.appendFileSync`（单行 JSON + `\n`）+ `fs.readFileSync`；读取时**逐行 try/catch**，坏行跳过并计入 `corrupt` 计数。
- 目录创建用 `fs.mkdirSync(..., {recursive:true})`；任何写失败只 `console.log` 告警并返回 `{ok:false}`，**绝不让插件抛错影响会话**。
- `PERSE_PROOF_HOME` 环境变量可覆盖根目录（测试与影子模式用）。

## A4. 接口冻结（实现代理必须严格照此导出）

```js
// lib/config.js
export const DEFAULTS;                       // 见 SPEC §4
export function resolveConfig(raw);           // → {config, warnings:[]}

// lib/store.js
export function createStore({rootDir, logger});
//  .append(sessionId, type, data) → {ok, ts}|{ok:false,error}
//  .read(sessionId) → [{ts,type,data,...}]（坏行跳过）
//  .counts(sessionId) → {records, corrupt}
//  .rootDir

// lib/digest.js
export function normalizeVolatile(text);      // 路径/端口/时间戳/sha 片段 → 占位符
export function contentDigest(criteria, opts);// → sha256 hex（opts.normalize 默认 true）
export function textDigest(text);             // → sha256 hex
export function fileDigest(path);             // → {ok, sha256?, bytes?, error?}

// lib/criteria.js
export function createCriteria({store, config, logger});
//  .freeze({sessionId, taskId, criteria, executor, artifacts}) → {revision, contentSha256, alerts:[]}
//  .amend({sessionId, taskId, criteria, reason}) → {revision, contentSha256, afterFailure}  （reason 空 → throw）
//  .current(sessionId, taskId) → revision|null
//  .recordRun({sessionId, taskId, command, executorPath, exitCode, pass, fail, skip, outputSha256}) → {criteriaSha, drift:null|{from,to,afterFailure}}
//  .addAllowlist({sessionId, file, pattern, reason, failureRef, upstreamId, reviewBy}) → {ok} （reason/failureRef 缺 → throw）
//  .list(sessionId) → {tasks:{[taskId]:{revisions:[]}}, allowlist:[]}

// lib/ledger.js
export function createLedger({store, config, logger});
//  .setFact({sessionId, key, value, evidence, note, source}) → {ok, errors:[]}
//  .facts(sessionId) → {[key]:{value, at, source, evidence}}
//  .noteToolCall({sessionId, name, args, toolResult}) → {alerts:[]}   // todo 丢项 + 写放大
//  .stats(sessionId) → {reads, writes, topRewritten:[{path,count}], alerts:[]}
//  .noteTodoList(sessionId, todos) → {alerts:[]}

// lib/claims.js
export function createClaims({store, config, logger});
//  .record({sessionId, claim, level, evidence, scope, sessionToolCalls}) → {ok, level, checked:[], errors:[]}
//  .list(sessionId) → [claimRecord]
//  .hasVerified(sessionId, sinceTs?) → boolean

// lib/util.js  （会话/agent 适配，唯一的框架耦合点）
export function sessionIdOf(agentOrSession);   // 兼容 session.id / session.sessionId / agent.session.*
export function lastAssistantText(agent);      // 扫日志取最后一条 assistant 文本；失败返回 ''
export function toolCallFrom(exec);            // → {name, args, path?}（尽力而为，绝不抛）
export function safeJson(text);                // 解析失败返回 null

// lib/report.js
export function createReport({ctx, config, logger});
//  .install() → {ok, order}   注册系统提示词段（判重 + try/catch）
//  .text() → string           汇报契约正文（测试直接断言）

// lib/gates.js
export function createGates({config, logger, store, claims});
//  .scanCompletion(text) → {hit, phrases:[]}
//  .scanCodenames(text)  → {count, samples:[]}
//  .evaluate({sessionId, text, turnKey}) → {steer:null|{kind:'claim'|'jargon', message}}  // 受 maxGatesPerTurn 约束
//  .reset(); .quota()

// lib/budget.js
export function createBudget({config, logger, store});
//  .noteTurn({sessionId, tokens, toolCalls, newArtifacts, ledgerWrites}) → {alerts:[]}
//  .noteDispatch({sessionId, tool, prompt}) → {declaredBudget:null|number}
//  .status(sessionId) → {...}

// lib/commands.js
export function createCommands({ctx, config, logger, store, ledger, criteria, claims, budget, gates});
//  .install() → {ok}

// lib/index.js
export const name = 'perse-proof';
export const Config = undefined;              // 不导出（避免 schemastery 依赖），配置在 apply 里自校验
export function apply(ctx, config);
```

**约定**：
- 所有 `createXxx` 的依赖通过参数注入（便于 `tests/mock-ctx.mjs` 单测），**模块内不得直接 import 其他模块的单例**。
- 面向用户的文本（工具返回值、命令输出、注入提示）一律**中文白话**，不出现本插件内部字段名。
- 任何外部调用包在 `try/catch` 里；插件不得因自身异常中断会话。

## A5. 工具清单（名字冻结）

| 工具名 | 关键参数（JSON Schema） |
|---|---|
| `proof_fact_set` | `key`(必填,string) `value`(必填,string) `evidence`(array) `note` |
| `proof_facts` | `key`(string,可选) |
| `proof_criteria_freeze` | `criteria`(必填,array of {id,desc,check}) `taskId` `executor` `artifacts` |
| `proof_criteria_amend` | `taskId` `criteria`(必填) `reason`(必填) |
| `proof_criteria_check` | `taskId` |
| `proof_verify_run` | `taskId` `command` `executorPath` `exitCode` `pass` `fail` `skip` `outputSha256` |
| `proof_allowlist_add` | `file`(必填) `pattern`(必填) `reason`(必填) `failureRef`(必填) `upstreamId` `reviewBy` |
| `proof_claim` | `claim`(必填) `level`(enum verified/partial/unverified) `evidence`(必填,array) `scope` |
| `proof_claims` | — |

斜杠命令：`/proof status|facts|criteria|claims|alerts|help`。

## A6. 打包与挂载（走 bundle 路线，**不要**改 profile 的 cordis.patch.yml）

实测结论：`dsh plugin --profile web add <tgz>` 是 pnpm 转发器，**从不改** `cordis.patch.yml`；
若包声明了 `dsh.bundle`，它会把包名追加进 `dsh.profile.bundles` **自动挂载**（本机 `perse-cua` 就是这么挂的）。
无 bundle 的包只会被当普通依赖，还需要手工插 `- insert:` 块——而 profile 里已有并发写入者，且有 R-07 冲突与**静默失败**（`name:` 写错零诊断）风险。

因此本插件：`package.json` **声明 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`**，`cordis.patch.yml` 内容为（**必须用 `- insert:` 包一层**，裸 `- id:` 会被 loader 当成"patch 已存在的 entry"而报 `patch: entry "..." not found`，实测会直接启动失败）：

```yaml
# Bundle layer contributed by perse-proof.
#
# Applied when the package is listed in a profile's `package.json` under
# `dsh.profile.bundles`. A profile may equivalently insert the same row from its
# own cordis.patch.yml; do ONE of the two, never both — the loader id must be
# unique (preflight rule R-07).
- insert:
    - id: perse-proof
      name: perse-proof
      description: 证据与判据闸门
```

> 更正记录：本附录 v1 给出的示例省略了 `- insert:`，是错的；由测试代理在隔离实例上实测捕获（`dsh --profile web --dump-config` 报
> `[perse-proof] patch: entry "perse-proof" not found`）。正确格式与 `perse-updater`、`perse-cua` 的 bundle 层文件逐字同构。

流程：`npm pack` → 备份 profile 的 `package.json` 与 `cordis.patch.yml` → `dsh plugin --profile web add <tgz>` → 确认 `dsh.profile.bundles` 里出现 `perse-proof` → 新会话验证工具表与 `/proof`。

**影子验证（先做，绝不碰 3080）**：`PERSE_PROOF_HOME`/隔离 `DSH_HOME` + `--port 3199+`，`dsh web --port 3199 --no-open`，
检查启动日志出现插件加载痕迹、HTTP 可达、工具已注册；验证后彻底关闭并确认端口释放。
