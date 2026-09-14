# DSH 插件 API 核实笔记（rc.2 实装版）

> **证据来源**：已安装的 rc.2 包，不是 alpha 源码仓库。
> 所有包路径前缀统一记作 `R = <DSH_HOME>/runtime/0.1.5-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
> （该目录下每个包 `package.json` 的 `version` 都是 `0.1.5-rc.2`；`<DSH_HOME>/profiles/node_modules/@deepseek-ai/*` 全部是指向这里的符号链接。）
> 文中 `R/xxx/lib/index.js:NN` 即「真实文件:行」证据。alpha 仓库 `<harness-checkout>` 仅用于交叉印证；凡与实装冲突处，一律以实装为准，并在文中标注。
>
> 标注约定：**未验证** = 没有读到直接证据，不要当结论用；**⚠️** = 与常见预期不符 / 容易踩坑。

---

## 0. 与任务清单前提不符之处（先看这里）

| # | 任务里的说法 | rc.2 实装真相 |
|---|---|---|
| 1 | `session.append(...)` 可以给自定义事件带上 `ignorable` | **不能**：`append` 第三参只认 `surfaceOp`/`sourceEventSeqs`，`{ignorable:true}` 被**静默丢弃**。而持久化读取侧要求仓库外事件必须带该标记才能重载 ⇒ **自定义事件名会写出 rc.2 自己拒绝加载的日志**（见 §1 易错点 2 与规避手段） |
| 2 | `ctx.sessionProjections.register` 的参数 schema | `stateSchema`/`viewSchema` 是 **zod**，而插件 `Config` 是 **schemastery**，两者同包共存、别混用 |
| 3 | `ctx.tools.register` 有 `handler` / `toolFilter` 字段 | **没有**。执行函数叫 `execute(args, exec)`；可见性用 `ctx.tools.restrict({allow,deny})`（仅 scoped）或 `ctx.tools.guard(fn)` |
| 4 | 参考 `dsh-tool-todo` / `dsh-tool-present` 的 tool 定义 | 它们用 `defineTool` + **DSH 自有映射式参数规格**；但你也可以**直接用原始 JSON Schema** 调 `ctx.tools.register`（本机 `dsh-zai-search-tools` 就是这么跑的） |
| 5 | 必须硬编码 `order: 2900` | 不必：`ctx.systemPrompt.getSectionOrder('TOOL_REPORT')`。`SECTION_ORDERS` **未导出**，但该实例方法就是它的 getter |
| 6 | `ctx.systemPrompt.section` 支持 `placeholders` / `maxChars` | **不存在这两个字段**。rc.2 只有 `name`/`order`/`text`/`complete`；动态能力走 `variable()` + `{{name}}` |
| 7 | `agent/turn-stopping` 用返回值 / `ctx.steer()` 阻止结束 | 它是 **serial，返回值被丢弃**；唯一手段是 `agent.steer(message)` 往 `nextStep` 投递。且 `ctx.steer()` 不存在，是 `agent.steer()` |
| 8 | 参考 `dsh-goal` 里的 turn-stopping 用法 | `dsh-goal` **根本没注册** turn-stopping；续轮逻辑在 **`dsh-goal-round-driver`**，走 `agent/status==='idle'` → `agent.followup()`（**next-turn**，不是 next-step） |
| 9 | `tool/call` / `tool/result` 是总线事件 | 它们是**会话日志事件**（durable）；总线上的真名是 `tools/result`（emit，两个位置参数 `(exec, result)`），另有 `tools/pre-execute`/`tools/execute`/`tools/post-execute` 三个 waterfall |
| 10 | 在 turn-stopping 里读本轮助手最终文本 | payload 只有 `{agent, turn, signal}`，**读不到**；但 `assistant/message` 已先提交，可 `session.eventAt(seq)` 扫日志（官方 `dsh-headless` 就是这么做） |
| 11 | `ctx.util.crypto` / `dsh-util-crypto` 算 sha256 | **该包不做哈希**（只有 `bytesToBase64`/`randomUUID`）；用 `node:crypto` 的 `createHash('sha256')` |
| 12 | `ctx.goals` 有 `get/set/update/complete/pause` | 真名是 `get/disarm/create/edit/pause/resume/complete/block/clear`，**全部同步**，无 `set`/`update`；写操作要带 CAS `ref {id, revision}` |
| 13 | `inject` 一个不存在的服务 | cordis 层**永久 pending、不报错、无超时**；但 DSH 启动审计会抛 `"...N entries did not activate\n...: pending (waiting for services: X)"` 并阻止启动（仅对 loader entry 生效） |
| 14 | 用 `ctx.goals !== undefined` 做可选依赖 | **会抛错**（`cannot get property "goals" without inject`）。必须 `ctx.get('goals')`，或 `ctx.inject([...], cb)` |

---

## 1. 会话事件追加：`session.append(type, data, ...opts)`

### 1.1 签名（真实）

```ts
// R/dsh-session/lib/types/index.d.ts:238
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
): SessionEvent<T>;
```

`SessionEventType` = 合并后的 `SessionEventMap` 的 key；`SurfaceEventType` 只有四个：
`'system/message' | 'user/message' | 'assistant/message' | 'tool/result'`（`R/dsh-session/lib/types/types.d.ts:413`）。

返回值 = **已写入的那条事件**，`seq`/`time` 由运行时补齐（`R/dsh-session/lib/index.js:1170-1186`）：

```js
append(type, data, ...opts) {
  const surfaceOpts = opts[0];
  const surfaceMetadata = {
    ...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
    ...surfaceOpts?.surfaceOp === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp }
  };
  const dataSnapshot = snapshotJsonValue(data);
  if (dataSnapshot === void 0) throw new Error(`session event "${type}" carries non-JSON-serializable data`);
  ...
  const event = deepFreeze({ type, seq: SessionSeq(this.log.length), time: Date.now(), data: dataSnapshot, ...surfaceMetadataSnapshot });
```

### 1.2 自动包装
- `seq`：`this.log.length`，单调、连续、从 0 开始（`types.d.ts` 里 `seq` 契约是 contiguous）。
- `time`：`Date.now()`（Unix 毫秒）。
- `data`：**深快照 + deepFreeze**。你之后改原对象不会影响日志；`event.data` 读回来是日志里的那份。
- **不是**自动包 `{ data: ... }`：你传给 `append` 的第二参就是 `data` 本体。

### 1.3 自定义事件类型要声明吗？
- **TypeScript**：要。用 declaration merging，且合并目标是 **`@deepseek-ai/dsh-session/types`** 子路径（**不是** 包根）：

  ```ts
  // R/dsh-tool-present/lib/types/types.d.ts:11-20
  declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
      'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] };
    }
  }
  ```
  同理可合并投影表：`declare module '@deepseek-ai/dsh-session-projection/types' { interface SessionProjectionStateMap { todos: TodoItem[] | null } }`（`R/dsh-tool-todo/lib/types/types.d.ts:28`）。
- **JS 插件（无 TS、无构建）**：不需要任何声明，`append` 运行时不查事件名表。实测（node 直连实装包）：

  ```
  header= { version: 3, id: 'probe-1', createdAt: ..., isSeeded: false }
  unknown-type append OK keys= [ 'type', 'seq', 'time', 'data' ] ignorable= undefined
  Date throws: session event "perse/bad" carries non-JSON-serializable data
  undefined throws: session event "perse/undef" carries non-JSON-serializable data
  surface-without-op throws: session event "user/message" is surface-eligible and requires a surfaceOp marker
  ```

### 1.4 最小示例（照抄）

```js
// append 本身不要求开着的 turn（present 之所以要求，是它自己的业务规则）；
// 下面用 tools/result 是因为那里能拿到 exec.agent.session
// （present 的写法：见 R/dsh-tool-present/lib/index.js:110-120）
ctx.on('tools/result', (exec, result) => {
  if (result.isError) return;
  const session = exec.agent?.session;
  if (!session) return;
  // 第三参是可选的 surface 元数据；非 surface 事件**不要**传任何东西
  const event = session.append('perse/proof', { turn: 1, ok: true });
  // event = { type, seq, time, data }，data 是深冻结快照
});
```
⚠️ **不要**试图写 `session.append('perse/proof', data, { ignorable: true })` —— 第三参只认 `surfaceOp`/`sourceEventSeqs`，`ignorable` 被静默丢弃，而它恰恰是仓库外事件能否被重新加载的关键（见 1.5 第 2 条）。

### 1.5 易错点
1. **⚠️ 第三参 `opts` 只认 `surfaceOp` / `sourceEventSeqs`；传 `{ ignorable: true }` 会被静默丢弃**（`R/dsh-session/lib/index.js:1171-1174` 只构造这两个字段）。实测 `Object.keys(event)` 里没有 `ignorable`。
2. **⚠️ 这直接导致仓库外插件的自定义事件会让会话「重启后读不出来」。** 读取侧：
   `R/dsh-session-persistence/lib/index.js:184`
   ```js
   if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(
     `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`, location);
   ```
   `KNOWN_SESSION_EVENT_TYPES` 是**构建期静态生成**的仓库内事件名集合（`R/dsh-session/lib/types/known-event-types.js:21`），下游插件的事件名**永远不在里面**（其注释原话：*"Downstream (out-of-repo) plugin events are outside this list by construction. The persisted SessionEvent.ignorable marker is the compatibility mechanism"*）。
   而 `append` 又不提供写 `ignorable` 的入口 ⇒ 真实后果：**自定义事件名会把日志写成 rc.2 自己拒绝加载的日志**（`validateStoredEvents` 在 `dsh-session-persistence-jsonl` 恢复路径上被调用：`R/dsh-session-persistence-jsonl/lib/index.js:1816 / 2576 / 2679`）。
   **可用的规避（机制已实测，端到端未验证 = 未验证）**：`KNOWN_SESSION_EVENT_TYPES` 是可变的 `Set`，且在进程内是同一个模块实例（实测 `size 57` → `add('perse/probe')` 后 `has()===true`）。插件可在 `apply` 里
   ```js
   import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
   KNOWN_SESSION_EVENT_TYPES.add('perse/proof');
   ```
   这样本进程的读路径会放行；但**它改的是进程内全局集合、不是持久化标记**，其它进程/未加载该插件的实例仍会拒绝。**未验证**：重启后由同一插件先 add 再读的实际时序。
3. **`data` 必须是无损 JSON**：`BigInt/函数/symbol/undefined/NaN/Infinity/-0/循环引用/稀疏数组/Date/Map/Set/类实例` 全部 **抛错**（不是静默）。要传哈希/时间请用字符串或数字。
4. **表面（surface）四类事件必须带 `surfaceOp`**（`'append'` 或 `{op:'replace',startSeq,endSeq}`），否则抛错；且 `assistant/message` **禁止** `sourceEventSeqs`。
5. **`append` 期间不可重入**：在其发布边界内再 append 会抛 `session append cannot reenter while another append is being published`（`R/dsh-session/lib/index.js:1181`）。
6. 监听者抛错**不会**回滚 append：日志已提交，观察者异常被逐个包含（`append` 的文档 + `notifyResult` 同款做法）。

### 1.6 相关：`deliverables/presented` 的完整写法（官方参考）
`R/dsh-tool-present/lib/index.js:110-120`：先在 tool 里把结果暂存到 `WeakMap`（key = exec 对象），在 `tools/result` 里取出再 append：

```js
ctx.on("tools/result", (exec, result) => {
  const delivery = pending.get(exec);
  pending.delete(exec);
  if (delivery === void 0 || result.isError) return;
  const { session, turn, files } = delivery;
  session.append("deliverables/presented", { turn, callId: exec.callId, files });
});
```

---

## 2. 会话投影：`ctx.sessionProjections.register({...})`

服务来源包：`@deepseek-ai/dsh-session-projection`（`R/dsh-session-projection/lib/types/index.d.ts`）。`ctx.sessionProjections` 由 `declare module '@deepseek-ai/cordis' { interface Context { sessionProjections: SessionProjectionRegistry } }` 合并进来。

### 2.1 签名（真实）

```ts
// R/dsh-session-projection/lib/types/index.d.ts（ProjectionDefinition）
register<K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K]>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'> & { wire: NonNullable<ProjectionDefinition<K, S>['wire']> }
): () => void;                                    // 客户端可见：必须给 wire
register<K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>, S ...>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'>
): () => void;                                    // 仅主机可见：省略 wire
```

`ProjectionDefinition` 字段：

| 字段 | 必须 | 说明 |
|---|---|---|
| `key` | ✅ | 投影键，即 `SessionProjectionStateMap` 的键 |
| `stateSchema` | ✅ | **Zod** 类型（`import type { ZodType } from 'zod'`）——用来校验持久化缓存里的旧 state。**注意不是 schemastery** |
| `init(header, inheritedEventCount)` | ✅ | 空日志的初始 state；参数是 `SessionHeader` 与 `SessionLogOffset` |
| `apply(state, event)` | ✅ | **纯同步** fold：`(prevState, committedEvent) => nextState`。事件与己无关时**必须返回同一个引用**（`Object.is` 相等 ⇒ 零下游工作） |
| `wire.viewSchema` / `wire.view(state)` | 客户端可见时 ✅ | `viewSchema` 也是 **Zod**；`view(state)` 产出 wire 值，对象值需复用引用以抑制发布 |
| `stateVersion` | ✅ | 非负整数；fold 语义或序列化字段变化时 **必须 bump**，否则旧缓存行会被前向套用成垃圾 |

### 2.2 最小示例（照抄 `dsh-tool-todo` 的真实结构）

```js
// 来源：R/dsh-tool-todo/lib/index.js:80-94（真实代码）
import { z } from 'zod';
const todosProjectionSchema = z.union([z.array(z.object({
  content: z.string(),
  status: z.union([z.literal('pending'), z.literal('in_progress'), z.literal('completed')]),
})), z.null()]);

ctx.sessionProjections.register({
  key: 'todos',
  stateSchema: todosProjectionSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === 'todo/write') return event.data.todos;
    if (event.type === 'turn/start') return null;   // 每轮清零
    return state;                                   // ← 无关事件必须原样返回
  },
  wire: { viewSchema: todosProjectionSchema, view: (state) => state },
  stateVersion: 2,
});
```

goal 的真实定义（主机可见 + 裁剪后的客户端值，`R/dsh-goal/lib/index.js:439-453`）：

```js
const goalProjectionDefinition = {
  key: 'goal',
  stateSchema: goalProjectionStateSchema,
  init: () => ({ current: null, seenGoalIds: [], failure: null }),
  apply: applyGoalProjection,
  wire: { viewSchema: goalProjectionSchema, view: (state) => state.current },
  stateVersion: 6,
};
```

### 2.3 读回当前值

```ts
// R/dsh-session-projection/lib/types/index.d.ts
stateOf<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined;
snapshot(session, keys?): ProjectionSnapshot;     // { asOfSeq, values } —— 所有客户端可见单元的同一水位切割
cachedSnapshot(session, keys?): ProjectionSnapshot | undefined;  // 不 fold 历史，只是提示
onChanged(listener: (session, key, value, seq) => void): () => void;
checkpoint(session): ProjectionCheckpoint; restoreFloor(...); restore(...); hydrate(...); viewCheckpoint(...);
```

真实调用示例：`R/dsh-tool-present/lib/index.js:78`

```js
const boundary = ctx.sessionProjections.stateOf(exec.agent.session, "turnBoundary");
if (boundary === undefined || boundary.openTurnStartSeq === null) throw new Error("present requires an open turn");
```

### 2.4 易错点
1. **`stateSchema` / `viewSchema` 用 zod**，而插件 `Config` 用 schemastery（`@deepseek-ai/schemastery`）。两个库同时在同一个包里出现是正常的（`R/dsh-tool-todo/lib/index.js:1-2` 同时 import 了两者）——别混用。
2. **`apply` 必须同步、且未命中时返回同一引用**。返回新对象会触发下游重新计算与发布（文档明说 `Object.is`）。
3. **注册是 fiber effect，自动清理**：文档原文 —— *"Register one domain's unit. The registration is an effect on the calling context's fiber: disposing the fiber (or calling the returned disposer) removes the key — and the unit's cached cells — from subsequent drives and snapshots."* 返回值就是精确的 disposer（`() => void`）。插件写在 `apply(ctx)` 里、不手动调用 disposer 也会随插件卸载消失。
4. **同键多注册 = 计数共享**：同一 tool 包挂到 N 个 preset 就注册 N 次，键活到最后一次卸载。
5. **不 `inject` 就访问 `ctx.sessionProjections` 会抛错**（见 §10）。
6. state 必须是**纯 JSON**（持久化缓存前提）。

---

## 3. 工具注册：`ctx.tools.register(...)`

服务来源包：`@deepseek-ai/dsh-tools`。

### 3.0 两条注册路线（都能用，别混淆）⚠️

| | A. `defineTool({...})`（官方便利封装） | B. `ctx.tools.register({...})`（裸 `ToolDefinition`，纯 JS 友好） |
|---|---|---|
| `parameters` | `ParameterSchemaSpec` **映射**：`{ key: { type:'string', required:true, description } }`，根是隐式对象 | **原始 JSON Schema**：`{ type:'object', properties:{...}, required:['x'] }` |
| `output.schema` | `ValueSchemaSpec`（同样会被编译） | 原始 JSON Schema |
| 需要 import | `import { defineTool } from '@deepseek-ai/dsh-tools'` | 不需要 import |
| 校验时机 | `defineTool` 构造时编译 + 校验参数规格 | `register()` **只校验 `output`**（`output.schema` 必须是受支持的 JSON Schema + `render` 是函数），`parameters` 不校验 ⇒ 写错的 parameters 可能拖到请求组装时才炸 |

证据：`ToolSchema.parameters` 定义是 `Record<string, unknown>` + 注释 "JSON Schema object for the arguments"（`R/dsh-llm/lib/types/types.d.ts:397-402`）；`register()` 实现（`R/dsh-tools/lib/index.js:2773-2782`）：
```js
register(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || ...) throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  assertSupportedJsonSchema(output.schema);
  ... if (name === "run_code") throw ...;
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

**本机正在运行的纯 JS 插件就是路线 B 的真实样例**：`<DSH_HOME>/profiles/web/node_modules/dsh-zai-search-tools/index.js`（`type: module`，无构建步骤，`export const name` / `export const inject = ['tools']` / `export function apply(ctx)`），它注册的 `zai_search` / `zai_set_key` 就是当前会话可见的工具：
```js
// 该文件 :120-143（逐字）
ctx.tools.register({
  name: 'zai_search',
  description: '...',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的内容' },
      count: { type: 'integer', description: '返回结果数 1-50，默认 10' },
      host: { type: 'string', enum: ['zai', 'bigmodel'], description: '...' },
      recency: { type: 'string', enum: ['noLimit','oneDay','oneWeek','oneMonth','oneYear'], description: '...' },
    },
    required: ['query'],
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => renderJson(value) },
  timeoutMs: 35000,
  isConcurrencySafe: () => true,
  async execute(args) { return await searchZai(ctx, args === null || typeof args !== 'object' ? {} : args) },
});
```
⇒ 想写零依赖纯 JS 插件、又不想引入 `defineTool` 编译步骤，**路线 B 完全可行**（并且已在 rc.2 上跑通）。

### 3.1 签名（真实）

```ts
// R/dsh-tools/lib/types/index.d.ts:601
register(definition: ToolDefinition): () => void;   // 返回精确 disposer（effect）

// R/dsh-tools/lib/types/schema.d.ts:239 —— 官方构造器
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>
): ToolDefinition;
```

`DefineToolOptions`（`R/dsh-tools/lib/types/schema.d.ts:178-231`）：

```ts
{
  name: string;                       // 唯一；保留名 run_code 会失败
  description: string;                // 发给模型
  parameters: ParameterSchemaSpec;    // 见下：DSH 自有的 JSON-Schema-like 规格，不是 zod/schemastery
  output: {
    schema: ValueSchemaSpec;          // 成功值的 JSON Schema 校验
    render(args, value): ContentBlock[];
    presentationMeta?(args, value): JsonValue;
  };
  timeoutMs?: number;                 // 协作式超时预算（由 dsh-tool-call-timeout-policy 的 tools/execute wrapper 执行）
  isConcurrencySafe?(args): boolean;  // 只认显式 true
  execute(args, exec: ToolRunContext): Promise<value>;   // 返回 output.schema 声明的规范值
  finalizeContent?(exec, result): ContentBlock[] | undefined;
  presentCall?(args): ToolCallView | undefined;
  presentResult?(args, result: ToolResult): ToolResultView | undefined;
}
```

**参数 schema 用的是 DSH 自己的规格**（不是 schemastery、不是 zod）：

```ts
// R/dsh-tools/lib/types/schema.d.ts:74-84
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true };
export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec; [key: symbol]: never };
```
参数根本身是**隐式开放对象**；required 靠每个属性上的 `required: true` 标注。`output.schema` 同理是 `ValueSchemaSpec`（`string|number|integer|boolean|null|array|object|json|oneOf` 各有一个 `*ValueSchemaSpec`）。
想直接给原始 JSON Schema 也可：包导出 `assertObjectJsonSchema` / `validateJsonSchemaValue`（`R/dsh-tools/lib/types/index.d.ts:17`）。

### 3.2 `exec`（`ToolRunContext`）形状

```ts
// R/dsh-tools/lib/types/index.d.ts:197-221, 284-301
interface ToolExecutionInput {
  readonly callId: ToolCallId;
  readonly rootCallId?: ToolCallId;      // 根调用可省
  readonly name: string;
  readonly arguments: unknown;           // 已解析的 JSON 参数
  readonly agent?: Agent;                // 由 agent loop 填入；非 agent 调用为 undefined
  readonly parent?: ToolExecutionToken;  // run_code 子派发时的不透明父 token
  readonly signal: AbortSignal;          // 必填，调用方取消
}
interface ToolRunContext extends ToolExecution {
  readonly rootCallId: ToolCallId;
  readonly token: ToolExecutionToken;
  deferContext(context: UserMessage): void;   // 把 context 挂到本次结果的末尾（loop 在 tool/result 之后追加）
  concludeTurn(): void;                        // 把本次成功结果标记为「本轮终止」
}
```

### 3.3 真实调用示例（照抄 `dsh-tool-present`，`R/dsh-tool-present/lib/index.js:23-109`）

```js
ctx.tools.register(defineTool({
  name: 'present',
  description: '...',
  parameters: { files: { type: 'array', required: true, items: {
    type: 'object', additionalProperties: false,
    properties: {
      path: { type: 'string', required: true, description: '...' },
      description: { type: 'string' },
    },
  } } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      turn: { type: 'integer', required: true },
      files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, description: { type: 'string' } } } },
    } },
    render: (_args, value) => [{ type: 'text', text: value.files.map(f => `Presented ${f.path}`).join('\n') }],
  },
  async execute(args, exec) {
    if (exec.agent === void 0) throw new Error('present requires an agent Session');
    // ...
    exec.signal.throwIfAborted();
    return { turn, files };
  },
}));
```

### 3.4 文本返回 / 抛错 / 带 code
- **返回文本**：`execute` 只返回**规范值**；模型可见文本由 `output.render(args, value)` 产出 `ContentBlock[]`（通常 `[{ type:'text', text }]`）。不要自己去拼 message。
- **抛错**：`throw` 普通 `Error` → 变成 `isError` 结果，`result.error` 带 `{ name, code }`；要带稳定 code 请用 `HarnessError` 或其子类：

  ```ts
  // R/dsh-llm/lib/types/error.d.ts:12-15
  class HarnessError extends Error { readonly code: string; constructor(message: string, code: string, options?: ErrorOptions); }
  // R/dsh-fs/lib/types/types.d.ts:169-172
  class FsError extends HarnessError { readonly code: FsErrorCode; constructor(message: string, code: FsErrorCode, options?: ErrorOptions); }
  ```
  真实用例 `R/dsh-tool-present/lib/index.js:94`：
  ```js
  if (info === void 0) throw new FsError(`Cannot present ${file.path}: file not found. ...`, 'FS_NOT_FOUND');
  ```
  `FsErrorCode` 全集（`R/dsh-fs/lib/types/types.d.ts:162`）：
  `'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE' | 'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR' | 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND' | 'FS_ABORTED'`
- **取消**：`TOOL_ABORTED = 'ABORTED'`（body 已启动）/ `TOOL_ABORTED_BEFORE_DISPATCH`（未启动），`R/dsh-tools/lib/types/index.d.ts:353-355`。
- **未知工具**：`ToolNotFoundError`，`code: 'UNKNOWN_TOOL'`。

### 3.5 易错点
1. **没有 `handler` 这个字段**：叫 `execute(args, exec)`。也没有 `toolFilter` 字段 —— 可见性用 `ctx.tools.restrict({allow, deny})`（**只能在 agent 作用域调用**，全局调用抛错：`R/dsh-tools/lib/types/index.js:481`），或 `ctx.tools.guard(fn)`（返回字符串即拒绝该次调用，单调不可被后续 guard 翻回允许）。
2. 参数 schema 的 `required` 是**属性级标注**，不是 JSON Schema 的根级 `required: []` 数组。`additionalProperties: false` 只在你自己写 object 节点时出现（todo 就是这么显式拒绝未知 item key 的）。
3. `output.schema` 是**强制**的；`execute` 返回的值会按它校验（`ToolOutputError`）。
4. 作用域规则：scoped 注册**遮蔽**全局同名；同一层重复注册 + 保留名 `run_code` 会失败。
5. `presentCall`/`presentResult` 必须**纯函数、无副作用**（回放时会再跑一遍，只能依赖 `args`）。
6. 并发：只有 `isConcurrencySafe` 显式 `return true` 才可并行；抛错/省略/非 true 一律独占。

---

## 4. 系统提示词段：`ctx.systemPrompt.section(...)`

服务来源包：`@deepseek-ai/dsh-system-prompt`。

### 4.1 签名（真实）

```ts
// R/dsh-system-prompt/lib/types/index.d.ts:47-68
export interface PromptSection {
  readonly name: string;
  readonly order: number;                                   // 升序拼接；同序按 name 的 code-unit 序
  readonly text: string | ((context: AssembleContext) => string);  // 支持动态 provider
  readonly complete?: boolean;                              // 视作完整系统提示词
}
// :233
section(section: PromptSection): () => void;                // 返回精确 Cordis effect disposer
```

同族方法（`R/dsh-system-prompt/lib/types/index.d.ts:225-286`）：
`context(ctx)`（动态上下文，落成 durable 的 user-role 快照）、`variable(name, provider)`（`[a-z][a-z0-9_]*`，`provider(context) => string | undefined`）、`tools(provider)`、`suppressRuntimeContext()`、`getSectionOrder(name)`、`getContextOrder(name)`、`assemble(context?)`。
**没有 `placeholders`、也没有 `maxChars` 字段**（全文件无此二者；`未验证`：其它包是否有别的截断机制）。

### 4.2 `order` 怎么拿 2900（任务里的关键问题）

`SECTION_ORDERS` **没有从包里导出**（`R/dsh-system-prompt/lib/index.js` 末尾 export 列表只有 `PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, SystemPrompt, TOOL_ORDER_REST, joinContextSections, renderContextSections, renderContextSnapshot, renderPrompt`）。它只以**类型**形式导出：`export type PromptSectionOrderName = keyof typeof SECTION_ORDERS`（`index.d.ts:143`）。

表本体：`R/dsh-system-prompt/lib/index.js:10-41`，其中 `TOOL_REPORT: 2900`（`:35`），`TOOL_SUBAGENT: 2800`，`DELIVERABLE_FILE_REFERENCES: 9000`，`HARNESS_SOURCE: 1e4`。

**JS 插件的两种拿法**：
1. **推荐**：`ctx.systemPrompt.getSectionOrder('TOOL_REPORT')` → `2900`（实例方法，`R/dsh-system-prompt/lib/index.js:248` 就是 `return SECTION_ORDERS[name]`）。要有 `systemPrompt` 在 `inject` 里。
2. 硬编码 `2900`（表是构建期常量，rc.2 实测值；跨版本可能漂移，硬编码就得自己承担风险）。

### 4.3 与任务前提的核对
- 服务名 `"systemPrompt"`（`R/dsh-system-prompt/lib/index.js:211`），`Context.systemPrompt` 声明合并见 `R/dsh-system-prompt/lib/types/index.d.ts:10-13`。
- **`section` 只收一个对象**，不存在位置参数形式（`index.d.ts:233`；实现 `R/dsh-system-prompt/lib/index.js:238-241`）：
  ```js
  section(section) {
    if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
    return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
  }
  ```
- **rc.2 的 `PromptSection` 只有 4 个字段**：`name` / `order` / `text` / `complete`。**没有 `variable`、`placeholders`、`maxChars`**（已全树 grep；`placeholders`/`maxChars` 只命中无关包 `dsh-llm-pi-ai`、`dsh-hook-protocol`、`dsh-session-query-sqlite`）。动态能力走 `variable()` + 文本里写 `{{name}}`。
- ⚠️ 任务里点名的 `dsh-agent-instructions` **并不注册 system prompt section**：它的 `inject = ["sessionProjections"]`（`R/dsh-agent-instructions/lib/index.js:1072`）。它注入的是 §6 的 `agent/pre-step` 消息。

### 4.4 最小示例（照抄 `dsh-tool-goal`，`R/dsh-tool-goal/lib/index.js:257-263`）

```js
function apply(ctx, config) {
  ctx.systemPrompt.section({
    name: 'tool:goal',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: guidance(resolved.blockedAfterConsecutiveRounds),
  });
}
```
函数式 text / scope 感知（`R/dsh-plan-mode/lib/index.js:170-176`）：
```js
ctx.systemPrompt.section({
  name: 'plan:policy',
  order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
  text: (context) => {
    if (context.agent === void 0) return '';
    return this.pendingIntents.get(context.agent.session)?.active ?? this.loggedActive(context.agent.session) ? this.section : '';
  },
});
```
`complete: true` + 显式 `ctx.effect`（`R/dsh-persona/lib/index.js:34-40`）：
```js
ctx.effect(() => ctx.systemPrompt.section({
  name: PERSONA_PREFIX_SECTION,
  order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
  text: config.prefix,
  ...config.complete ? { complete: true } : {},
}), 'persona.section()');
```

### 4.5 `variable()` 真实签名与语义
```ts
// R/dsh-system-prompt/lib/types/index.d.ts:276
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;
```
- 名字必须匹配 `/^[a-z][a-z0-9_]*$/`（`R/dsh-system-prompt/lib/index.js:58`）。
- 引用语法严格 `{{name}}`；**未知/未定义变量在渲染期抛错**（不是注册期）；孤立 `{{` 当普通文本；替换值不再二次扫描（`R/dsh-system-prompt/lib/index.js:150-175`）。
- `AssembleContext` 真实字段：`scope`、`signal`（`index.d.ts:37-45`），加 dsh-agent 合并进来的 `agent`（`R/dsh-agent/lib/types/runtime-types.d.ts:14-19`）。
- 唯一 shipped 注册（`R/dsh-agent-loop/lib/index.js:1534-1536`）：
  ```js
  ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
  ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
  ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd);
  ```
- **未验证**：rc.2 shipped 代码里没有任何 section 文本真的写了 `{{...}}`（只有注释与 persona 模板文档）。

### 4.6 注册是 fiber effect（自动清理）
`section()` → `this.layers.effect(this.ctx, ...)`（`R/dsh-system-prompt/lib/index.js:240`）→ `ScopedLayers.effect` → `ctx.effect(...)`（`R/dsh-scope/lib/index.js:189-192`）→ cordis `Context.effect`（`R/cordis/lib/types/fiber.d.ts:157,159`，返回 `Disposable`）。`section()` 直接把该 disposer 返给你。手动 `ctx.effect(...)` 只影响清理顺序，**非必需**。

### 4.7 易错点
1. **同名重复注册会抛错**；文案分两种（`R/dsh-system-prompt/lib/index.js:188`）：全局 `prompt section "X" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`；scoped 则是 `... is already registered in this scope`。
2. **要覆盖官方段（如 `deployment:persona-prefix`）必须在 agent 的 scoped ctx 注册**；无 scope 注册只会撞名报错（`R/dsh-persona/lib/index.js:30-33`）。
3. `complete: true` 时**只允许一个生效**，两个 → `multiple complete prompt sections are active: ...`（`R/dsh-system-prompt/lib/index.js:333`）。生效时 waterfall 监听者无法再追加/替换该 scope 的 prompt（`index.d.ts:19-22`）。
4. **`getSectionOrder('拼错的名字')` 不抛错，返回 `undefined`**，随后 `section()` 才抛 `TypeError ... order must be a finite number`（`R/dsh-system-prompt/lib/index.js:239`）。
5. `order` 允许负数/小数，只要 `Number.isFinite`。排序：`a.order - b.order || compareNames(a.name, b.name)`（`R/dsh-system-prompt/lib/index.js:96-98`）。
6. 空文本段在渲染时被丢弃（`:112`）。
7. 沙箱动态插件（`cordis_define`）**不能 `import`**（`R/dsh-tool-cordis/lib/index.js:8981`：*"Do not use TypeScript types, as, decorators, import, require, or JSX."*）⇒ 只能 `ctx.systemPrompt.getSectionOrder(...)` 或硬编码 `2900`。

---

## 5. 命令注册：`ctx.commands.register(...)`

服务名 `"commands"`（`R/dsh-commands/lib/index.js:250`；`Context.commands` 声明合并 `R/dsh-commands/lib/types/index.d.ts:60-64`）。

### 5.1 签名（真实）

```ts
// R/dsh-commands/lib/types/index.d.ts:91
register(definition: CommandDefinition): () => void;   // fiber effect，返回 disposer
```
实现（`R/dsh-commands/lib/index.js:257-260`）：
```js
register(definition) {
  const registered = normalizeDefinition(definition);
  return this.layers.effect(this.ctx, (layer) => layer.commands.insert(registered.definition.name, registered), { label: "commands.register()" });
}
```

`CommandDefinition` **只有这 5 个字段**（`R/dsh-commands/lib/types/index.d.ts:37-52`）：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | **小写、不带前导 `/`**，须匹配 `/^[a-z][a-z0-9_-]*$/u`（`R/dsh-commands/lib/index.js:71`） |
| `description` | ✅ | trim 后非空；用于发现/补全 UI |
| `input` | ✘ | `{ hint: string; attachments?: boolean }`；`hint` 非空 |
| `recordInput` | ✘ | 默认 `true`；`false` 时 `command/run` 不写 `args` |
| `handler` | ✅ | `(invocation) => CommandResult \| Promise<CommandResult>` |

**⚠️ 不存在 `aliases` / `hidden` / `args` / `schema` / `usage` / `category`。** 校验器 `normalizeDefinition`（`R/dsh-commands/lib/index.js:142-173`）是**白名单**：多写的字段被**静默丢弃、不报错** —— 很容易误以为 `aliases` 生效了。

### 5.2 handler 入参（`CommandInvocation`）

`R/dsh-commands/lib/types/index.d.ts:18-35`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `commandId` | `CommandId` | 已写入 `command/run` 的配对 id |
| `agent` | `Agent` | **session 走 `invocation.agent.session`** |
| `rawInput` | `string` | 命令名之后的原文，**含分隔空白** |
| `attachments` | `readonly (ImageBlock \| FileBlock)[]` | 仅当声明 `input.attachments` 时非空 |
| `signal` | `AbortSignal` | UI 取消信号 |

**⚠️ 不是 `{ session, input, args }`**。原文叫 `rawInput`。解析正则 `/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u`，`rawInput = line.slice(match[0].length)`（`R/dsh-commands/lib/index.js:94-106`）。

### 5.3 返回值 / 结果怎么回给用户与模型

```ts
// R/dsh-commands/lib/types/types.d.ts:33-41
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq }
  | { readonly kind: 'error';   readonly text: string };
```
- **回给用户**：handler 返回值 → `command/done` 事件（`R/dsh-commands/lib/index.js:332-341`）→ 浏览器把 `command/run` + `command/done` 折成聊天节点并渲染 `outcome: {kind, text?, sourceEventSeq?}`（`R/dsh-client-ui-chat/lib/client.js:5727`, `5835-5860`）。**handler 不要自己 echo**。
- **回给模型：注册表永远不会把命令发给模型**（`R/dsh-commands/lib/types/index.d.ts:50`：*"Execute against the receiving agent without sending the command to the model"*）。要让模型看见必须自己在 handler 里投递：

  ```js
  // R/dsh-command-goal/lib/index.js:97-106（真实代码）
  import { createUserMessage } from '@deepseek-ai/dsh-llm';
  invocation.agent.followup(createUserMessage({
    content: [...invocation.attachments, { type: 'text', text: 'Reference attachments for the goal objective.' }],
    source: { kind: 'user' },
  }));
  ```
  三种投递：`agent.followup(msg)`（下一轮 turn）/ `agent.steer(msg)`（本轮下一步，见 `R/dsh-plan-mode/lib/index.js:212-218`）/ `agent.inject(msg)`（不唤醒）。声明见 `R/dsh-agent/lib/types/runtime-types.d.ts:186/192/199/208`。
- 校验规则：`kind ∈ {'success','error'}`；`error.text` 非空字符串；`success.sourceEventSeq` 为非负安全整数，否则 `TypeError`（`R/dsh-commands/lib/index.js:175-196`）。

### 5.4 抛错 vs 返回 error 结果 ⚠️
`R/dsh-commands/lib/index.js:377-385`：
```js
try {
  const output = command.definition.handler(invocation);
  result = normalizeResult(parsed.name, await withAbort(Promise.resolve(output), signal));
} catch (error) {
  this.settleThrown(agent.session, parsed.name, commandId, error);   // 仍写 command/done{kind:'error'}
  throw error;                                                        // 但异常继续外抛
}
```
⇒ **handler 抛错时 `command/done` 会记 error，但异常会外抛使 `commands.execute` 这个 Remote 调用 reject**。
**面向用户的可预期失败请 `return { kind:'error', text }`**；`throw` 只留给真 bug。`signal.aborted` 走同一条 throw 路径（`withAbort`，`:116-140`）。携带附件但未声明 `input.attachments` → 自动 error `/${name} does not accept attachments`（`:346-352`）。

### 5.5 最小示例（照抄）

```js
export const name = 'my-cmd-plugin';
export const inject = ['commands'];

export function apply(ctx) {
  ctx.commands.register({
    name: 'ping',                       // 小写、无 '/'
    description: 'Ping the harness',
    // 注意：省略 input = 无参命令
    handler: (invocation) => {
      const { agent, rawInput, attachments, signal, commandId } = invocation;
      if (rawInput.trim() !== '') return { kind: 'error', text: 'Usage: /ping (no arguments)' };
      // 可选：让模型看见
      // agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } }));
      return { kind: 'success', text: 'pong' };
    },
  });
}
```
带 input / 附件（`R/dsh-command-goal/lib/index.js:174-182`）：
```js
ctx.commands.register({
  name: 'goal',
  description: 'set or view the goal for a long-running task',
  input: { hint: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true },
  handler: (invocation) => executeGoalCommand(ctx, invocation),
});
```

### 5.6 易错点
1. **多余字段静默忽略**（`aliases`/`hidden`/`args` 无效且不报错）。
2. `name` 不能带 `/` 且必须小写；`description` / `input.hint` 不能是空串（`R/dsh-commands/lib/index.js:143-153`）。
3. **声明 `input` 会改变客户端交互**：只要 `desc.input !== undefined`，UI 就总是先进入「索要参数」流程，即使命令无参（`R/dsh-client-ui-commands/lib/client.js:747-749`）。无参命令别声明 `input`。
4. 收附件必须显式 `input.attachments: true`。
5. 同一 layer 重名会抛错（`R/dsh-scope/lib/index.js:27-29`）；全局与 scoped 同名是遮蔽关系（`R/dsh-commands/lib/types/index.d.ts:73-76`）。
6. `{kind:'success'}` 省略 `text` 合法，UI 只显示命令名（`types.d.ts:35`）。
7. `error.text` 为空 → `TypeError`（`R/dsh-commands/lib/index.js:186-190`）。
8. `recordInput: false` 只影响写入日志的 `command/run.args`，**不影响** handler 拿到的 `rawInput`（`:327-332`）。
9. 注册是 fiber effect（`ctx.effect`）：写在 `apply()` 里卸载即回收；也可 `ctx.effect(() => ctx.commands.register({...}), 'label')` 包裹（`R/dsh-session-log-export/lib/index.js:476-485`）。
10. **未验证**：沙箱动态插件（`cordis_define`）能否注册 slash 命令（未找到服务白/黑名单代码，未实测）。

---

## 6. 事件监听

### 6.1 总线形态（真实）
`ctx.on(name, fn, options?)`，返回 disposer。注册**与 dispatch 模式无关**：模式由**派发点**决定（`R/cordis/lib/types/events.d.ts:19`：`'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`）。
`options` 只有 `{ prepend?: boolean; global?: boolean }`（`events.d.ts:102`）；`on` 签名 `events.d.ts:92` `on(name, listener, options?): () => boolean`。

派发实现（`R/cordis/lib/index.js`）：
- `emit`（`:280`）：逐个调用，返回忽略，异常被包含。
- `serial`（`:289`）：`await` 每个；返回 `isBailed` 才提前返回 —— **普通返回值被忽略**。
- `waterfall`（`:317`）：
  ```js
  waterfall(...args) {
    const cbs = this.dispatch("waterfall", args);
    const inner = args.pop();
    const next = () => (cbs.shift() ?? inner)(...args);
    args.push(next);
    return next();
  }
  ```
  ⇒ 监听器签名 `(payload, next)`；**不调 `next()` 即否决**默认行为；**必须 return**（`await next()` 或自己的替换值）。`next()` 是唯一形态，没有 `next(ctx)` 这种调用。

### 6.2 `agent/pre-step` —— waterfall ✅
```ts
// R/dsh-agent/lib/types/runtime-types.d.ts:305-319
'agent/pre-step'(this: Scoped<Agent>, payload: {
  agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal;
}, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
```
派发点 `R/dsh-agent-loop/lib/index.js:894`：
```js
const decision = await this.dispatch.waterfall("agent/pre-step", {
  messages: claimed, ...position, signal,
}, () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));
```
返回类型（`runtime-types.d.ts:92-99`）：
```ts
export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true };
```
**能不能注入模型可见内容**：能，**不是** append `user/message`，而是**往 decision.messages 里 splice 一条 user-role `UserMessage`**。官方做法（`R/dsh-agent-instructions/lib/index.js:1270-1288`）：
```js
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
  const decision = await next();
  ...
  const desired = await compose(agent, signal, messages, pending);
  if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) { syncInbox(agent, messages, desired); return decision; }
  if (desired === void 0 || decision.messages.some((m) => sameContextPayload(m, desired))) return decision;
  const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m));
  return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired) };
});
```
它的 `source` 字段是真的（`R/dsh-agent-instructions/lib/index.js:766-774`）：
```js
createUserMessage({ content: [{ type: "text", text }], source: { kind: "agent-instructions", form: "instructions", changes } })
```

### 6.3 `agent/turn-stopping` —— serial（**不是 waterfall**）⚠️
```ts
// R/dsh-agent/lib/types/runtime-types.d.ts（@mode serial）
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void;
```
派发点 `R/dsh-agent-loop/lib/index.js:966`：
```js
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial("agent/turn-stopping", { turn, signal });
  signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;
target = "next-step";
```
⇒ **返回值被丢弃**；「阻止本轮结束」靠**副作用**：`agent.steer(message)` 往 `nextStep` 投递，循环重读 inbox 非空 ⇒ 再走一步。
真实用法（`R/dsh-hooks-claude-code/lib/index.js:292-301`，codex 版同构 `R/dsh-hooks-codex/lib/index.js:272`）：
```js
ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
  const merged = await runPoint("Stop", "", stopPayload(agent), { agent, turn, signal });
  if (merged.decision === "deny") {
    agent.steer(createUserMessage({ content: [{ type: "text", text: merged.reason ?? "continue: blocked by Stop hook" }], source: PLUGIN_SOURCE }));
  }
});
```
inbox API（`R/dsh-agent-loop/lib/index.js:789-791`）：
```js
followup(input) { this.send(input, "next-turn", true); }   // 下一轮 turn
steer(input)    { this.send(input, "next-step", true); }   // 本轮再走一步
inject(input)   { this.send(input, "next-step", false); }  // 不唤醒
```
**⚠️ 与任务前提不符**：`dsh-goal` **没有**注册 `agent/turn-stopping`（`R/dsh-goal/lib/index.js:594-603` 只注册 `agent/session-start` 与 `session/event`）。goal 的「再来一轮」在 **`dsh-goal-round-driver`**：`agent/status === 'idle'` 时 `requestDrive()`（`R/dsh-goal-round-driver/lib/index.js:218`）→ `agent.followup(message)`（`:154`，目标是 **next-turn**），消息 source = `{ kind:'goal', goalId, revision, round }`（`:133-143`）；它的 `agent/pre-step` 监听（`:280`）只是用在预约过期时 `return { kind:'reject' }` 的**栅栏**（`:309`）。
⇒ 想要「本 turn 内逼模型再走一步」用 `steer`；想要「本轮结束后再开一轮」用 `followup`。

### 6.4 能读到本轮助手最终文本吗？——payload 里没有
- payload 精确为 `{ agent, turn, signal }`，无文本字段。
- 仓库内唯一的两个 turn-stopping 监听都不读助手文本；`R/dsh-hooks-codex/lib/index.js:275` 甚至**硬编码** `last_assistant_message: null`（全实装树中 `last_assistant_message` 只此一处）。
- **可行替代（已验证机制）**：`agent/turn-stopping` 派发时，本轮的 `assistant/message` **已经提交**（step 里 append：`R/dsh-agent-loop/lib/index.js:1108`；turn-stopping 在之后 `:966`）。所以直接扫日志：

```js
import { SessionSeq } from '@deepseek-ai/dsh-session';
function lastAssistantText(session, fromSeq = 0) {
  let text = '';
  const len = session.seq;                       // 下一个 seq（= log.length）
  for (let seq = fromSeq; seq < len; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (event?.type !== 'assistant/message') continue;
    const joined = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (joined !== '') text = joined;
  }
  return text;
}
```
官方同款扫描：`R/dsh-headless/lib/index.js:35`（`summarize`）。读 API：`session.eventAt(seq)`（`R/dsh-session/lib/types/index.d.ts:178`）、`session.snapshotEvents(from?, toExclusive?)`（`:187`）、`session.ownEvents()`（`:192`）、`session.deriveEventMessage(event)`（`:292`）、`session.deriveMessages()`（`:285`）。
缓存路线：`ctx.on('session/event', (session, event) => ...)` 是**提交后**的 firehose（emit 点在 `Session.append` 内，`R/dsh-session/lib/index.js:1197/1202`，在 `this.log.push(event)` **之后**）。
`assistant/message` 载荷：`{ turn, step, message: AssistantMessage, stream, usage?, interrupted? }`（`R/dsh-session/lib/types/types.d.ts:309`）。

### 6.5 `tool/call` / `tool/result` ⚠️ 名字有两套
- **总线事件里没有 `tool/call` / `tool/result`**。总线上的真名是 `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/ptc-dispatch-log`、`tools/result`、`tools/change`（`R/dsh-tools/lib/types/index.d.ts:28-100`）。
- **`tool/call` / `tool/result` 是会话日志事件**（durable），不是总线事件：

  ```ts
  // R/dsh-session/lib/types/types.d.ts:333, :351
  'tool/call':   { turn: number; step: number; callId: ToolCallId; name: string; arguments: string };  // arguments 是模型产出的原始 JSON 字符串
  'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string }; meta?: JsonValue };
  ```
  append 点：`R/dsh-agent-loop/lib/index.js:688`（call）与 `:703`（result）。统计「编辑/读取次数」用 `session/event` 过滤这两个 type，或直接扫日志。
- **总线 `tools/result`**：`@mode emit`，监听器是**两个位置参数**，不是 payload 对象：
  ```ts
  // R/dsh-tools/lib/types/index.d.ts:88
  'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined;
  ```
  派发点 `R/dsh-tools/lib/index.js:3287`（`notifyResult`）：`callback(exec, result)`，`exec` 已被 `Object.freeze`；scope key = `exec.agent`（`R/dsh-scope/lib/invariant.js:34`）。
  `exec` 字段：`callId, rootCallId, name, arguments`（已解析）, `agent?, parent?, signal, token` —— 都是普通只读属性，**没有 getter**。
  `result`：成功 `{isError:false, value, content, meta?, additionalContexts?, concludesTurn?}` / 失败 `{isError:true, error:{message,info?}, content, meta?, additionalContexts?}`。

### 6.6 可直接用于初始化的钩子
| 事件 | 真名/存在 | 模式 | 签名 |
|---|---|---|---|
| `agent/session-start` | ✅ | emit | `(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource })`，`source ∈ 'startup'\|'resume'\|'clear'\|'compact'` |
| `agent/created` | ✅ | emit | `(this: Scoped<Agent>, payload: { agent: Agent })` |
| `agent/request` | ✅ | **waterfall** | `(payload: {agent,turn,step,signal}, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>` —— 替换调用配置；**不能改消息**，模型可见内容必须走日志化通道 |
| `agent/turn-start` | ❌ **不存在** | — | 用会话事件 `turn/start`（`{turn}`） |
| `session/created` | ✅ | emit | `(this: Scoped<Session>, session: Session)` —— **1 个位置参数** |
| `session/disposed` | ✅ | emit | `(this: Scoped<Session>, session: Session)` |
| `session/event` | ✅ | emit | `(this: Scoped<Session>, session: Session, event: SessionEvent)` —— **2 个位置参数**（不是 payload 对象！） |
| `session/flush` | ✅ | parallel | `(this: Scoped<Session>, session: Session)` |
| `goal/changed` | ✅ | emit | `(this: Scoped<Agent>, payload: { agent: Agent; change: GoalChanged })` |

`goal/changed` 载荷（`R/dsh-goal/lib/types/domain.d.ts:68-90`）：`GoalChanged = { operation: GoalOperation; ref: GoalRef; goal?: GoalView }`；`operation ∈ 'create'|'edit'|'pause'|'resume'|'complete'|'block'|'clear'`。派发点 `R/dsh-goal/lib/index.js:877`，**在** durable `goal/change` append（`:865`）**之后**。真实消费者 `R/dsh-goal-round-driver/lib/index.js:234`。
另有进程内事件 `goal/activation-changed`（`R/dsh-goal/lib/index.js:798`，载荷 `{ sessionId, goal?: {id, revision, activation} }`）。

### 6.7 易错点（事件总线）
1. **同一个名字的模式要按派发点判断**：`agent/pre-step` 是 waterfall（要 `next()`），`agent/turn-stopping` 是 serial（返回被忽略），`tools/result` 是 emit（异常被包含）。写错模式不会报错，只是行为不是你以为的。
2. **参数形态不统一**：agent 系事件是**一个 payload 对象**（且 runtime 会注入 `agent` 字段：`R/dsh-agent/lib/index.js:205-239` 的 `fused`）；`session/event`、`session/created`、`tools/result` 是**纯位置参数**。
3. `{ prepend: true }` 可插到队首（真实用例 `R/dsh-agent/lib/index.js:171`）；`{ global: true }` 绕过 scope 过滤（`R/dsh-goal/lib/invariant.js:45`）。
4. scope 过滤：agent 系以 `payload.agent` 为 key；`session/created|disposed|event|flush` 的 key 是 `null`（只判存在）（`R/dsh-scope/lib/invariant.js:12-38`）。

---

## 7. 文件系统与哈希

### 7.1 `ctx.fs` 的真实方法表（完整，没有更多）

服务名 `"fs"`，由抽象基类注册（`R/dsh-fs/lib/index.js:58-61`）；`Context.fs` 声明在 `R/dsh-fs/lib/types/index.d.ts:15-18`。下列 15 个成员就是**全部**：

| 方法 | 签名 | 行 |
|---|---|---|
| `sandboxMode`(getter) | `get sandboxMode(): SandboxMode \| undefined`（`undefined` = 该后端不做任何限制） | d.ts:75 |
| `resolve` | `resolve(path, opts?: {cwd?, signal?}): Promise<FsTarget>` | d.ts:85-88 |
| `processPath` | `processPath(target): string`（同步） | d.ts:97 |
| `processPathFromHostPath` | `processPathFromHostPath(hostPath): string \| undefined` | d.ts:106 |
| `fileUrl` | `fileUrl(target): string` | d.ts:114 |
| `contains` | `contains(parent, child): boolean` | d.ts:122 |
| `stat` | `stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo \| undefined>` | d.ts:129 |
| `lstat` | `lstat(path: string, opts?: {cwd?: string}, signal?: AbortSignal): Promise<FsPathInfo \| undefined>` | d.ts:144-146 |
| `readText` | `readText(target, signal?): Promise<string>` | d.ts:153 |
| `streamText` | `streamText(target, signal?): Promise<AsyncIterable<string>>` | d.ts:163 |
| `readBytes` | `readBytes(target, signal, maxBytes): Promise<Uint8Array>` | d.ts:174 |
| `readByteRange` | `readByteRange(target, {offset,length}, signal?): Promise<Uint8Array>` | d.ts:188-191 |
| `listDir` | `listDir(target, signal?): Promise<FsDirEntry[]>`（**不是 `readdir`**） | d.ts:199 |
| `writeText` | `writeText(target, content, expected?, signal?, sandboxPolicy?): Promise<FsWriteOutcome>` | d.ts:212 |
| `editText` | `editText(target, edit, expected?, signal?, sandboxPolicy?): Promise<FsEditOutcome>` | d.ts:226-228 |

**⚠️ 不存在** `readFile` / `writeFile` / `readdir` / `mkdir` / `rm` / `exists` / `glob`（已全树 grep 确认 0 命中）。

### 7.2 返回形状 / 错误

- `stat`/`lstat` **缺失路径返回 `undefined`，不抛**（`R/dsh-fs-local/lib/index.js:763`（stat）、`:775`（lstat））。`resolve` 对缺失路径**照常返回 target**（realpath 最近存在祖先 + 补后缀，`:167-193`），所以正确模式是 **先 `resolve` 再 `stat` 判存在**（present 就是这么写的：`R/dsh-tool-present/lib/index.js:92-94`）。
- 返回字段**只有 `version` / `type` / `size`**，**没有 mtimeMs/ino/mode**（`R/dsh-fs-local/lib/index.js:764-768`）。`FsInfo.type ∈ 'file'|'directory'|'other'`，`FsPathInfo.type` 多一个 `'symlink'`（`R/dsh-fs/lib/types/types.d.ts:67-88`）。
- `version` 是**不透明字符串 token**（本地后端形如 `dev:ino:size:mtimeNs:ctimeNs`，`R/dsh-fs-local/lib/index.js:142-143`），d.ts **明令禁止解析**。想拿 mtime 没有正当通道。
- **⚠️ 非 `ENOENT`/`ENOTDIR` 的失败（如 EACCES）会原样抛出裸 Node Error，不是 `FsError`**（`R/dsh-fs-local/lib/index.js:211`）。
- abort 时抛 `FS_ABORTED`（`:760` / `:771`）；空白路径抛 `FS_NOT_FOUND`（`:772` / `:154`）。

### 7.3 `FsError` 与错误 code 如何到达模型

```js
import { FsError } from '@deepseek-ai/dsh-fs';       // 主入口导出：R/dsh-fs/lib/index.js:86
// R/dsh-fs/lib/index.js:34-40
var FsError = class extends HarnessError { code; constructor(message, code, options) { super(message, code, options); this.code = code; } };
```
`HarnessError`（`@deepseek-ai/dsh-llm`）：`constructor(message: string, code: string, options?: ErrorOptions)`，`name = new.target.name`（`R/dsh-llm/lib/index.js:121-127`）。
13 个 code（`R/dsh-fs/lib/types/types.d.ts:162`）：`FS_NOT_FOUND` `FS_NOT_DIRECTORY` `FS_NOT_TEXT` `FS_NOT_REGULAR_FILE` `FS_TOO_LARGE` `FS_PERMISSION_DENIED` `FS_SANDBOX_DENIED` `FS_IO_ERROR` `FS_STALE_VERSION` `FS_NOT_OBSERVED` `FS_AMBIGUOUS_EDIT` `FS_EDIT_NOT_FOUND` `FS_ABORTED`。

`throw new FsError('...', 'FS_NOT_FOUND')` 后，工具层这样包装（`R/dsh-tools/lib/index.js:2516-2524` + `:3486-3500`）：
```js
function errorInfo(error) { try { return error instanceof HarnessError ? { name: error.name, code: error.code } : void 0; } catch { return; } }
function toolErrorResult(error) {
  const info = errorInfo(error); const message = errorMessage(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true, error: { message, ...info ? { info } : {} } };
}
```
⇒ **模型只看到 `Error: <message>`；`{name, code}` 走 `result.error.info`**，并被写进 `tool/result` 事件的 `error: {name, code}`（`R/dsh-agent-loop/lib/index.js:707`）。所以「带 code 抛错」的正确做法就是抛 `HarnessError` 子类。

### 7.4 sha256

- **`dsh-util-crypto` 不做哈希**。它只导出 `bytesToBase64` 与 `randomUUID`（`R/dsh-util-crypto/lib/index.js:35`；package description = "Zero-dependency browser-safe UUID and byte-encoding helpers"）。
- **实际路线 = `node:crypto`**：
  ```js
  import { createHash } from 'node:crypto';
  const hex = createHash('sha256').update(textOrBytes).digest('hex');
  ```
  仓库内真实用法：`R/dsh-attachment-local/lib/index.js:270` `createHash("sha256").update(data).digest("hex")`；`R/dsh-agent-instructions/lib/index.js:9` 直接 `import { createHash } from "node:crypto"`；`R/dsh-atomic-write/lib/index.js:1` 导入 `node:crypto`/`node:fs/promises`/`node:path`。
- **未验证**：运行时是否对 node 内建零限制。已证「无 denylist 证据 + 大量已发布插件直接使用 node 内建」。
- 浏览器侧（client bundle）不能用 `node:crypto`，只有 host 侧插件可用。

### 7.5 最小示例

```js
import { FsError } from '@deepseek-ai/dsh-fs';
import { createHash } from 'node:crypto';

const cwd = '/work';
const opts = { cwd, signal };
const target = await ctx.fs.resolve(relPath, opts);
const info = await ctx.fs.stat(target, signal);
if (info === undefined) throw new FsError(`no such file: ${relPath}`, 'FS_NOT_FOUND');
const text = await ctx.fs.readText(target, signal);
const sha = createHash('sha256').update(text).digest('hex');
// 只判类型、且要拒绝符号链接本身：
const entry = await ctx.fs.lstat(relPath, { cwd }, signal);   // 注意：第2参 {cwd}，第3参 signal
if (entry !== undefined && entry.type !== 'file') return;
```

### 7.6 易错点
1. **⚠️ `lstat(path, {cwd}, signal)` 与 `stat(target, signal)` 参数位置不同**。把裸 `AbortSignal` 当 `lstat` 第 2 参传**不会报错**，`opts.cwd` 变 undefined 回落到 `config.cwd`、`opts.signal` 丢失 ⇒ **取消静默失效**（`R/dsh-fs-local/lib/index.js:771-775`）。
2. 除 `lstat` 外所有 IO 都吃 `FsTarget`（`{targetKey, displayPath}` 不透明结构，`R/dsh-fs/lib/types/types.d.ts:52-60`），不是路径字符串。
3. `readBytes(target, signal, maxBytes)` 里 signal 在 maxBytes **前**；`writeText(target, content, expected, signal, sandboxPolicy)` 共 5 参。
4. `writeText`/`editText` 按 `targetKey` 有 FIFO 串行锁（`:719`, `:727`）；写冲突的语义是 `FS_STALE_VERSION`。

---

## 8. goal 服务：`ctx.goals`

包 `@deepseek-ai/dsh-goal`；服务名 `"goals"`（`R/dsh-goal/lib/index.js:591-592`），`static inject = ["agents", "sessionProjections"]`（`:587`）。

### 8.1 读写 API —— **全部同步**（没有 `set` / `update`）

```ts
// R/dsh-goal/lib/types/index.d.ts:67-128
get(agent: Agent): GoalView | undefined;
disarm(agent: Agent): GoalView | undefined;
create(agent: Agent, request: CreateGoalRequest): GoalView;      // { objective, maxGoalRounds? }
edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView;
pause(agent: Agent, ref: GoalRef): GoalView;
resume(agent: Agent, ref: GoalRef): GoalView;
complete(agent: Agent, ref: GoalRef): GoalView;
block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView;
clear(agent: Agent, ref: GoalRef): GoalRef;                       // tombstone
```
`ref` 是 CAS：`GoalRef { id: GoalId; revision: number }`，revision 过期抛 `GOAL_STALE_REVISION`（`R/dsh-goal/lib/index.js:763`）。所有调用要求**精确的 live Agent 实例**（`assertLive`，`:768`，否则 `GOAL_AGENT_NOT_LIVE`）。
错误码全集 `GoalErrorCode`（`R/dsh-goal/lib/types/domain.d.ts:75`）：`GOAL_AGENT_NOT_LIVE | GOAL_NOT_FOUND | GOAL_ALREADY_EXISTS | GOAL_STALE_REVISION | GOAL_INVALID_OBJECTIVE | GOAL_INVALID_MAX_ROUNDS | GOAL_INVALID_BLOCK_REASON | GOAL_INVALID_EDIT | GOAL_INVALID_TRANSITION`。

### 8.2 读 `goal` 投影（预算/漂移模块要用的）

```js
// R/dsh-goal/lib/index.js:771-776 —— 服务自己就这么读，可照抄
state(session) {
  const state = this.ctx.sessionProjections.stateOf(session, "goal");
  if (state === void 0) throw new Error("goal projection is not registered");
  if (state.failure !== null) throw new Error(state.failure);
  return state.current;          // GoalProjection | null
}
```
- host state：`{ current: GoalProjection | null; seenGoalIds: GoalId[]; failure: string | null }`（`R/dsh-goal/lib/types/types.d.ts:101-108`）。
- wire 形状：`ctx.sessionProjections.snapshot(session, ['goal']).values.goal` → `GoalProjection | null`。
- 投影定义：`key:'goal'`、`stateVersion: 6`、`wire.view = (state) => state.current`（`R/dsh-goal/lib/index.js:439-453`）。

### 8.3 状态字段（预算/漂移要读的）

- `GoalSnapshot`（durable，`R/dsh-goal/lib/types/types.d.ts:47-56`）：`id`、`revision`、`objective`、`phase: 'active'|'paused'|'blocked'|'complete'`、`blockedReason?: { code, message }`（**仅 `phase==='blocked'` 时存在**）、`maxGoalRounds`。
- `GoalProjection`（投影值，`:90-99`）：`{ goal: GoalSnapshot; roundsStarted: number; createdAt: number; updatedAt: number }` ⇒ **预算看 `maxGoalRounds` vs `roundsStarted`**。
- `GoalView`（服务返回值，`:74-83`）：上述 + `activation: 'armed'|'disarmed'`（进程本地，**永不持久化**，投影里没有）。

### 8.4 观测变更
- `goal/changed`（scoped、per-agent，emit）：`(payload: {agent, change: GoalChanged})`，`GoalChanged = {operation, ref, goal?}`；在 durable `goal/change` append 之后派发（`R/dsh-goal/lib/index.js:865` → `:877`）。
- `goal/activation-changed`（进程本地）：`R/dsh-goal/lib/index.js:798-805`，载荷 `{ sessionId, goal?: {id, revision, activation} }`。
- 通用路线：`ctx.sessionProjections.onChanged(...)`。

### 8.5 最小示例
```js
// inject: ['goals','agents','sessionProjections']
const goal = ctx.goals.get(agent);                       // GoalView | undefined，同步
const proj = ctx.sessionProjections.stateOf(agent.session, 'goal')?.current;  // GoalProjection | null
if (proj && proj.roundsStarted >= proj.goal.maxGoalRounds) { /* 预算耗尽 */ }
if (goal) ctx.goals.pause(agent, { id: goal.id, revision: goal.revision });   // CAS
```

### 8.6 易错点
1. **⚠️ 服务方法全同步**，别 `await`（能跑但会误导）。
2. **⚠️ 命名两套**：工具参数（给模型）是 snake_case `max_goal_rounds` / `blocked_reason` / `goal_id`（`R/dsh-tool-goal/lib/index.js:284,329,376`）；服务 API 是 camelCase `maxGoalRounds` / `blockedReason` / `id`。
3. 任何一次变更都会让旧 `ref.revision` 失效；每次写前重读。
4. `roundsStarted >= maxGoalRounds` 时 `resume` 被拒（`R/dsh-goal/lib/index.js:697`）。
5. session resume/fork 后 goal 是 **disarmed**，需要人类授权的 `resume`（`:594-596`, `:686-698`）。
6. `stateOf` 在「goal 投影未注册」（即 `dsh-goal` 没装）时返回 `undefined` —— 别当「没有 goal」处理。

---

## 9. token / 上下文用量：`ctx.tokenMeter`

包 `@deepseek-ai/dsh-token-meter`；服务名 `"tokenMeter"`（`R/dsh-token-meter/lib/index.js:608-613`，`static inject = ["sessionProjections"]`）。

### 9.1 方法（同步）
```ts
// R/dsh-token-meter/lib/types/index.d.ts:46,57
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement;   // 同步
estimateMessage(message: Message): number;                                   // 同步
```
`TokenMeasurement = { logRevision, baseline: {kind:'none'|'estimated'|'usage', tokens, usage?}, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes: TokenSurfaceNode[] }`（`R/dsh-token-meter/lib/types/types.d.ts:24-37`）。

### 9.2 三个投影 key（就这三个）

注册点 `R/dsh-token-meter/lib/index.js:615-617`：

| key | stateVersion | host state（`stateOf` 拿到） | wire 值（`snapshot` 拿到） |
|---|---|---|---|
| `tokenUsage` | 2 | `{ totals: {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, last: {turn, step, buckets} \| null }`（`:371-378`） | `state.totals`（`:444-447`）—— 四个桶 |
| `contextPressure` | 4 | `{ surfaceTokens, contextWindow?, pressureTokens?, sampledSurfaceTokens?, claim? }`（`:397-407`） | `{ contextWindow?, pressureTokens?, projectedTokens? }`，`projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`（`:509-516`） |
| `contextBreakdown` | 4 | `{ nodes, breakdown: {systemTokens, toolsTokens, messageTokens} }`（`:214-221`） | `state.breakdown`（`:263-266`） |

key 类型合并到 `@deepseek-ai/dsh-session-projection/types`（`R/dsh-token-meter/lib/types/projection.d.ts:64-73`）。

### 9.3 怎么读当前值（⚠️ 语义陷阱）
```js
// inject: ['sessionProjections','tokenMeter']
const host = ctx.sessionProjections.stateOf(session, 'tokenUsage');   // { totals, last } | undefined
const wire = ctx.sessionProjections.snapshot(
  session, ['tokenUsage','contextPressure','contextBreakdown']
).values;                                                            // 客户端/序列化形状
const m = ctx.tokenMeter.measure(session);                           // TokenMeasurement
const off = ctx.sessionProjections.onChanged((s, key, value, seq) => { /* value = wire 形状 */ });
```
- `stateOf` 返回 **host 内部态**（live 引用，**勿改**）；`snapshot` 才返回 **wire 形状**。`tokenUsage` 恰好两者同构（`view = state.totals`），但 `contextPressure`/`contextBreakdown` 不同构。
- 两者都**同步**；key 未注册（token-meter 未加载）→ `undefined`，按「能力缺失」处理。

### 9.4 易错点
1. 别把 `stateOf` 的返回当 wire 值用（`contextPressure` 的字段名就不一样）。
2. `stateOf` 是 live 引用；要持久化/传递先深拷贝。
3. `contextPressure` 的字段**不是一次原子的请求观测**（`R/dsh-token-meter/lib/types/projection.d.ts:18-27` 明确说明）。

## 10. 插件对象形状与 inject

（cordis 4.0.2 / cordis-plugin-loader 1.0.3 / schemastery 3.18.2）

### 10.1 两种一等公民形状

**A. named exports 函数式（绝大多数包）** —— `R/dsh-command-goal/lib/index.js:8-9,173-174,185`：
```js
const name = "command-goal";
const inject = ["commands", "goals"];
function apply(ctx) { ... }
export { apply, inject, name };
```

**B. `default` 导出的 Service 类** —— `R/dsh-goal/lib/index.js:587-593`：
```js
static inject = ["agents", "sessionProjections"];
static Config = z.object({ defaultMaxGoalRounds: z.number().default(256) });
constructor(ctx, config = {}) { super(ctx, "goals"); ... }
```
（`export { GoalService, GoalService as default }`，`R/dsh-goal/lib/index.js:906`。）

加载器解析（`R/cordis/lib/index.js:1532-1537`）：函数直接用；对象则用其 `.apply`；类走 `new runtime.callback(ctx, config)`（`:1066-1070`）。

**⚠️ 坑：`default` 优先于 named exports。** `R/cordis-plugin-loader/lib/index.js:746-751`：
```js
unwrapExports(exports) {
  if (isNullable(exports)) return exports;
  exports = exports.default ?? exports;
  ...
}
```
即同时写 `export default` 和 `export const apply` 时 **default 胜出**。

TS 契约（`R/cordis/lib/types/registry.d.ts:47-81`）：
```ts
interface Base<T> { name?: string; Config?: StandardSchemaV1<any, T>; inject?: Inject; provide?: string | string[]; intercept?: Dict<boolean>; }
interface Function<T> extends Base<T> { (ctx: Context, config: T): any; }
interface Constructor<T> extends Base<T> { new (ctx: Context, config: T): any; }
interface Object<T> extends Base<T> { apply(ctx: Context, config: T): any; }
```

### 10.2 `inject`
`R/cordis/lib/types/registry.d.ts:13-15`：`(keyof M)[] | { [K in keyof M]?: M[K] }`。归一化实现 `R/cordis/lib/index.js:1490-1498`（数组 → 每个 name 映射为 `null`）。**YAML entry 上的 `inject` 也会合并进同一张 map**（`R/cordis-plugin-loader/lib/index.js:706-710`）。

### 10.3 `Config` 必须是 **Standard Schema**（不是"必须 schemastery"）
`R/cordis/lib/index.js:955-961`：
```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);
  if ("then" in result) throw new TypeError("Async config validation is not supported");
  if (result.issues) throw new ValidationError(result.issues);
  else return result.value;
}
```
- schemastery 确实实现了 `~standard`（`R/schemastery/lib/index.mjs:52-56`），所以官方包都用它。
- 传**裸对象** `Config: { a: 1 }` 会在运行时炸 `TypeError: Cannot read properties of undefined (reading 'validate')`（实测）。
- **异步校验被拒绝**。
- `ValidationError`：`R/cordis/lib/index.js:932-944`。

### 10.4 `apply` 可以是 async / generator / async generator
`R/cordis/lib/index.js:1141-1165`（`_execute`）接受：返回 `function`（effect/清理函数）、`null/undefined`、含 `then`（Promise）、`Symbol.iterator`（generator）、`Symbol.asyncIterator`。其它 → `TypeError("Invalid effect")`。实测 `async apply` 正常激活。

### 10.5 `inject` 一个不存在的服务会怎样 ⚠️（两句话都要记住）

**cordis 层：永久 pending，不报错、不抛、无超时。** `R/cordis/lib/index.js:1316-1328`：
```js
_refresh() {
  let epoch = false;
  epoch = "";
  for (const name of Object.keys(this.inject)) {
    const impl = this._store[name];
    if (!impl) { epoch = INACTIVE; break; }
    epoch += ":" + impl.fiber.uid;
  }
  this._setEpoch(epoch);
}
```
`await fiber.await()` 只在 `_error` 有值时才抛（`:1398-1402`）；全文件 grep `setTimeout|timeout` = 0 命中，**没有任何超时**。实测：`fiber.state=0`（pending），`await` 不抛；后补 `provide` 后自动 `apply` 并变 `state=2`。

**DSH 层：启动审计会 fail loudly。** `R/dsh-app-boot/lib/index.js:1483-1493`：
```js
if (state === FIBER_PENDING) {
  const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === void 0);
  const subject = missing.length === 1 ? "service" : "services";
  failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(", ") || "unknown"})`);
}
...
throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join("\n")}`);
```
调用点 `:1537` `await assertEntriesActivated(ctx, binName);`。
**范围限定**：该审计只覆盖 **loader entry（配置行）**。运行期用 `ctx.plugin()` 动态挂载的插件、或 preset 内组合的行，inject 缺失只会**静默 pending**。

### 10.6 防御式可选依赖：**必须用 `ctx.get(name)`** ⚠️

| 写法 | 结果 |
|---|---|
| `ctx.get('missing')` | 返回 `undefined`，**不抛** |
| `ctx.missing`（未 inject、未 provide） | **抛** `Error: cannot get property "missing" without inject` |
| `ctx.missing`（已 provide 但未 inject） | 正常情况下能解析到；但若 provider 未激活，抛 `cannot get required service "..." in inactive context` |

代理 trap 源码 `R/cordis/lib/index.js:672-698`；`ctx.get` 实现 `:762-764`：`get(name, strict = true) { return getTraceable(this.ctx, this._getImpl(name, strict)?.value); }`（`strict` 下 provider fiber 必须 `state === 2`）。
⇒ **绝对不要写 `if (ctx.goals !== undefined)`** —— 那会抛错。写 `const goals = ctx.get('goals'); if (goals === undefined) { ... }`。

安装树里的真实范式：
1. 运行期 `ctx.get` 判空：`R/dsh-host-plugin-inventory/lib/index.js:119-120`（`const presets = this.ctx.get("agentPresets"); if (presets === void 0) ...`）、`R/dsh-agent-loop/lib/index.js:1541-1542`、`R/dsh-agent-default-model/lib/index.js:67`。
2. **`ctx.inject([...], cb)`**：不把可选依赖列进 `inject`，而是在 `apply` 内延迟挂载 —— 教科书样例 `R/dsh-agent-tool-presentation/lib/index.js:24-29,46-48`：
   ```js
   // codeRuntime is NOT listed: a `native` row must mount in a deployment that composes no runtime,
   // and the mode-dependent wait is declared inside apply instead.
   const inject = ["tools"];
   ...
   ctx.inject(["codeRuntime"], (runtimeCtx) => { runtimeCtx.tools.presentAs(config.mode); });
   ```
3. **本机正在跑的纯 JS 插件自带这种注释**（`<DSH_HOME>/profiles/web/node_modules/dsh-zai-search-tools/index.js:13-16`）：
   ```js
   // Hard dependencies resolved before apply: the tools registry is used at
   // apply time. shell and credentials are read lazily inside execute via
   // ctx.get, so they are not injected here.
   export const inject = ['tools']
   // ...
   const creds = ctx.get('credentials');     // :31
   const shell = ctx.get('shell');           // :43
   ```

### 10.7 纯 JS 插件 + 本地路径加载（可行，已实证）

**真实在跑的纯 JS ESM 插件**：`<DSH_HOME>/profiles/web/node_modules/dsh-zai-search-tools/index.js`（`type: "module"`，`main`/`exports` 指向 `index.js`）。
加载入口 `<DSH_HOME>/profiles/web/cordis.patch.yml`：
```yaml
- insert:
    - id: zai-search-tools
      name: dsh-zai-search-tools          # 裸包名，经 profile 的 node_modules 解析
      description: Z.ai/智谱 Web Search API 适配工具（zai_search / zai_set_key）
```
profile 的 `package.json` 里声明 bundles 与依赖：
```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "perse-updater", "perse-cua"], "patchReload": "live" } }
```
**按绝对/相对路径加载也支持**：`R/dsh-app-boot/lib/index.js:1170-1178` 会把绝对路径或 `./`、`../` 开头的 `name` 重写成 `file://` URL；`:1324-1332` `const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;`。entry `name` 也支持包内子路径（`@deepseek-ai/dsh-web-app/startup`）。
**不支持**：`reusable`（全树 grep 0 命中）；`Plugin.Transform`（`schema: true` + 函数式 Config）类型声明存在但运行时无对应代码路径 ⇒ **未验证/推断不支持**。

### 10.8 最小插件骨架

```js
// $DSH_HOME/profiles/<profile>/node_modules/my-plugin/index.js   （package.json: type=module, exports="./index.js"）
export const name = 'my-plugin';
export const inject = ['tools', 'sessionProjections'];   // 硬依赖；可选依赖不要写这里
// export const Config = z.object({...})                 // 可选；须是 Standard Schema（schemastery 即可）

export function apply(ctx, config) {
  const off1 = ctx.tools.register({ /* ... */ });
  const off2 = ctx.sessionProjections.register({ /* ... */ });
  // 可选依赖：const goals = ctx.get('goals')  ← 不要用 ctx.goals !== undefined
  return () => { off1(); off2(); };                      // 可选：返回清理函数
}
```
在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 `insert` 一行 `{ id, name: my-plugin }` 即可加载。

---

## 11. 调试手段

### 11.1 `ctx.logger` —— 是可调用服务，两种用法都真
`R/cordis/lib/types/logger.d.ts:77-80`：
```ts
export interface LoggerService extends Record<LoggerType, LoggerMethod> { (name?: string): Logger; }
```
`LoggerType = 'error' | 'info' | 'warn' | 'debug'`（`logger.d.ts:10`）。
- `ctx.logger.info('...')` / `.warn` / `.error` / `.debug`：用 **fiber 派生名**（`hyphenate(fiber.name)`）。安装树里 220 处几乎全是这种形式（如 `R/dsh-mcp-client/lib/index.js:174,583`）。
- `ctx.logger('my-plugin').info('...')`：返回命名 `Logger` 门面。真实样例 `R/cordis-plugin-loader/lib/index.js:732`：`this.ctx.root.logger?.("loader").info("%s plugin %C", type, entry.options.name);`。

**⚠️ 级别阈值怪癖**（`R/cordis/lib/index.js:462-487`）：级别数值 `error=0, info=1, warn=2, debug=3`，比较是 `if ((exporter.levels?... ?? this.level ?? 1) < level) continue;` —— 默认阈值 `1` ⇒ **`warn` 与 `debug` 默认被吞掉，只有 `error`/`info` 会输出**。要放宽可用 `ctx.intercept('logger', { level: 3 })`（`:619-627`）。**未验证**：本机 home 层 patch 是否已放宽。

### 11.2 日志去哪了 —— **没有文件日志**
- 唯一注册的 exporter 是 cordis 内建的内存环形缓冲（1000 条）：`R/cordis/lib/index.js:583-604`。安装树中**没有任何包注册文件 exporter**。
- `~/.dsh/logs/` 下的文件是**运维 shell 重定向**产物，不是 DSH 机制。证据 `<DSH_HOME>/logs/restart-uc.sh:5-6,23`：
  ```bash
  LOG="$HOME/.dsh/logs/restart-uc-$(date +%Y%m%d-%H%M%S).log"
  exec >> "$LOG" 2>&1
  nohup dsh web --no-open >> "$LOG" 2>&1 &
  ```
  ⇒ **per-process，不是 per-session；且只有 `console.*` / stdout 才进去**（例：`dsh-web-3080.log` 里的 `dsh web: http://...` 横幅来自 `R/dsh-web-app/lib/index.js:203` 的 `console.log`；`[perse-cua] 56 tools advertised → 27 registered` 也是插件自己在 stdout 打印的）。**插件里想留痕，用 `console.log` 落到启动重定向的文件比 `ctx.logger.info` 更可靠。**
- 相关的落盘但不是日志：per-session 事件日志 `~/.dsh/sessions/<编码 cwd>/<sessionId>/session.v3.jsonl.zstd`；投影缓存 `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`（`R/dsh-session-projection-cache/lib/index.js:15,90`）。

### 11.3 在隔离实例里确认「插件已加载 / 工具已注册」

**CLI**（已实跑 `node $APP/lib/bin.js --help`，只读、未启服务）：
```
Usage: dsh [options] [command] [args...]
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  initialize a new custom profile from a shipped profile template
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-default-config          print the profile tree without its user layer or --patch overlays and exit
Commands:
  web       boot the web profile
  plugin    manage a profile's plugins by forwarding remaining arguments to pnpm in the profile directory
```
（来源 `$APP/lib/bin.js:85,100-105`。）**没有 `doctor` 子命令。**
⚠️ `--dump-config` 会**写盘**（`prepareProfile` 无条件 `writeFileSync(join(profile.dir, "cordis.yml"), ...)`）—— 只想看组合结果就直接读 `cordis.patch.yml` 三层（bundle → profile → `--patch`），bundles 顺序来自 profile 的 `package.json` 的 `dsh.profile.bundles`。

**HTTP / RPC**（无 `/health`、`/status` 路由）：
- 统一前缀 `/api`（`R/dsh-client-connection/lib/index.js:12-13`），未授权 401/403。
- 所有 Typert Remote 走一条 WebSocket 复用路径 `/api/remote.mux`（`R/dsh-api-gateway/lib/index.js:10-11,459-476`）。
- **列插件**：Remote `pluginInventory.list()` → `{entryId, moduleName, enabled, fiberPhase}`，`fiberPhase` 含 `"pending"|"active"|"failed"`（`R/dsh-host-plugin-inventory/lib/index.js:108-131`，phase 枚举 `:56-63`）。该行确实挂在本 web profile（`R/dsh-web-app/cordis.patch.yml:100-102`）。客户端调用样例 `R/dsh-client-ui-settings-plugin-inventory/lib/client.js:646,656-657`。
- **列工具**：cordis 工具面 `cordis_inspect_list` → `cordis_inspect_query`（platform=`Host`, provider=`Tool`, method=`listTools`）→ 内部就是 `ctx.tools.schemas(context.agent)`（`R/dsh-tool-cordis/lib/index.js:9038-9053`）。
- **查会话投影**：Remote `session/page`（`R/dsh-api-session-controller/lib/index.js:1359-1365`）；实时帧 `session/follow`。

### 11.4 最省事的自检套路（本机已验证可用）
1. 写插件时在 `apply()` 开头 `console.log('[my-plugin] apply ...')`，并起一个隔离 profile 跑 `dsh --profile <other> ...`（用 `--port 0` 让 OS 选口，`--no-open` 不开浏览器）。
2. 启动日志（stdout 重定向文件）里找 `[my-plugin]`；若插件 pending，`dsh-app-boot` 的审计会直接打印 `<entry>: pending (waiting for services: X)` 并**拒绝启动** —— 这是最好的注入名拼写检查。
3. 工具是否注册：让会话里调一次 `cordis_inspect_query`（`Tool.listTools`），或直接看模型可用工具列表。
4. 别指望 `ctx.logger.warn` 一定出现（默认阈值吞掉 warn/debug，见 11.1）。

### 11.5 易错点
1. `<DSH_HOME>/logs/*` 不是 DSH 内部日志；不要按「per-session 日志」去那里找。
2. `dsh --dump-config` 有副作用（写 `cordis.yml`）。
3. `fiberPhase: "pending"` 是**唯一**能从 HTTP 面看出「inject 拼错」的信号 —— 但它只在 loader entry 上有效。
4. `console.log` 进不了 GUI，只在启动时的 stdout 里。
