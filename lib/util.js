/**
 * perse-proof · lib/util.js
 *
 * 会话 / agent 适配层：本插件**唯一**与 DSH 框架耦合的地方。
 * 依据：docs/API-NOTES.md（rc.2 实装实测）。规则：
 *   - 零依赖、零 peer，只用 node: 内置模块，不 import 任何 @deepseek-ai/* 包；
 *   - 每个函数都必须容错：拿不到就返回空值，绝不向上抛错影响会话。
 */

import { randomUUID } from 'node:crypto';

/** 面向模型注入的单条提示上限（字），保持要求短而具体。 */
export const INJECT_MAX_CHARS = 200;

/** cordis 的 `{kind:'plugin'}` 消息来源（照抄官方 plan-mode / hooks-claude-code 写法）。 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'perse-proof' });

/**
 * 取一个 ctx 上的服务。**必须**用 ctx.get：
 * API-NOTES §0 第 14 条 —— 未 inject 时 `ctx.foo !== undefined` 会直接抛错。
 * @param {unknown} ctx 插件上下文
 * @param {string} name 服务名（如 'tools' / 'systemPrompt' / 'commands' / 'goals'）
 * @returns {any} 服务实例，或 undefined
 */
export function serviceOf(ctx, name) {
  try {
    if (ctx === null || ctx === undefined) return undefined;
    if (typeof ctx.get === 'function') return ctx.get(name);
    return undefined;
  } catch {
    return undefined;
  }
}

/** 把异常压成一行可读文本。 */
export function errorText(error) {
  try {
    if (error === null || error === undefined) return 'unknown';
    if (typeof error === 'string') return error;
    return String(error?.message ?? error);
  } catch {
    return 'unknown';
  }
}

/** 取整数，非法则用兜底值。 */
export function intOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 按字符数截断（不会切坏代理对，够用即可）。 */
export function truncate(text, max = INJECT_MAX_CHARS) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 尽力解析一段 JSON 文本。
 * @param {unknown} text
 * @returns {any|null} 解析失败返回 null
 */
export function safeJson(text) {
  try {
    if (text !== null && typeof text === 'object') return text;
    if (typeof text !== 'string' || text.trim() === '') return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 agent 或 session 上取 session 对象。 */
export function sessionOf(agentOrSession) {
  try {
    if (agentOrSession === null || agentOrSession === undefined) return undefined;
    if (agentOrSession.session !== undefined && agentOrSession.session !== null) return agentOrSession.session;
    // 已经是 session：有 eventAt 或 append
    if (typeof agentOrSession.eventAt === 'function' || typeof agentOrSession.append === 'function') return agentOrSession;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 兼容多种形状取会话编号。
 * @param {unknown} agentOrSession agent / session / exec.agent
 * @returns {string|undefined}
 */
export function sessionIdOf(agentOrSession) {
  try {
    const session = sessionOf(agentOrSession);
    const candidates = [
      session?.id,
      session?.sessionId,
      session?.header?.id,
      agentOrSession?.sessionId,
      agentOrSession?.id,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取会话的全部事件（优先用 snapshotEvents，退化为 eventAt 逐个读）。
 * @param {unknown} session
 * @param {number} fromSeq 起始序号（含）
 * @returns {any[]}
 */
export function eventsOf(session, fromSeq = 0) {
  const from = intOr(fromSeq, 0);
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const all = session.snapshotEvents();
      if (Array.isArray(all)) return from > 0 ? all.slice(from) : all;
    }
  } catch {
    /* 退化到 eventAt */
  }
  const out = [];
  try {
    const len = intOr(session?.seq, 0);
    for (let seq = from; seq < len; seq += 1) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined;
      if (event !== undefined && event !== null) out.push(event);
    }
  } catch {
    /* 忽略 */
  }
  return out;
}

/** 把消息的 content 块里的文本拼起来（只取 type==='text'）。 */
export function textOfContent(content) {
  try {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  } catch {
    return '';
  }
}

/**
 * 扫会话日志取最后一条助手文本。
 * API-NOTES §6.4：`agent/turn-stopping` 的 payload 里**没有**文本，只能扫日志
 * （`assistant/message` 在该事件派发前已提交）。
 * @param {unknown} agentOrSession agent（或 session）
 * @param {number} [turn] 只认这一轮的事件（省略则认最后一条）
 * @returns {string} 失败返回 ''
 */
export function lastAssistantText(agentOrSession, turn) {
  try {
    const session = sessionOf(agentOrSession);
    if (session === undefined) return '';
    const onlyTurn = Number.isFinite(turn) ? turn : undefined;
    let text = '';
    for (const event of eventsOf(session)) {
      if (event?.type !== 'assistant/message') continue;
      if (onlyTurn !== undefined && event?.data?.turn !== onlyTurn) continue;
      const joined = textOfContent(event?.data?.message?.content);
      if (joined !== '') text = joined;
    }
    return text;
  } catch {
    return '';
  }
}

/** 工具名 → 是否属于「写文件」类（用于统计新产物路径）。 */
const WRITE_TOOL_RE = /^(write|edit|multi_edit|apply_patch|create|create_file|notebook_edit)$/;

/** 从工具参数里尽力取目标路径。 */
export function pathFromArgs(name, args) {
  try {
    const bag = args !== null && typeof args === 'object' ? args : {};
    const raw = bag.path ?? bag.file_path ?? bag.filePath ?? bag.file ?? bag.target;
    if (typeof raw !== 'string' || raw === '') return undefined;
    if (typeof name === 'string' && !WRITE_TOOL_RE.test(name) && !/^(read|write|edit|multi_edit|apply_patch)$/.test(name)) {
      // 非文件类工具即使有 path 字段也不算产物
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * 汇总某一轮的统计（供 budget 使用）：工具调用数 / 新写入的产物路径 / 输出 token。
 * @param {unknown} session
 * @param {number} [turn]
 * @returns {{toolCalls:number,newArtifacts:number,artifacts:string[],tokens:number|undefined}}
 */
export function turnStats(session, turn) {
  const result = { toolCalls: 0, newArtifacts: 0, artifacts: [], tokens: undefined };
  try {
    const onlyTurn = Number.isFinite(turn) ? turn : undefined;
    const artifacts = new Set();
    let tokens;
    for (const event of eventsOf(session)) {
      const type = event?.type;
      if (type === 'tool/call') {
        if (onlyTurn !== undefined && event?.data?.turn !== onlyTurn) continue;
        result.toolCalls += 1;
        const path = pathFromArgs(event?.data?.name, safeJson(event?.data?.arguments));
        if (typeof path === 'string' && path !== '') artifacts.add(path);
      } else if (type === 'assistant/message') {
        if (onlyTurn !== undefined && event?.data?.turn !== onlyTurn) continue;
        const usage = event?.data?.usage;
        const value = [usage?.outputTokens, usage?.completionTokens, usage?.output_tokens].find((n) => Number.isFinite(n));
        if (Number.isFinite(value)) tokens = (tokens ?? 0) + value;
      }
    }
    result.artifacts = [...artifacts];
    result.newArtifacts = artifacts.size;
    result.tokens = tokens;
    return result;
  } catch {
    return result;
  }
}

/** 从工具名判断是不是派发类调用（子代理 / 工作流 / 循环）。 */
export const DISPATCH_TOOLS = Object.freeze(['subagent', 'subagent_fork', 'workflow', 'ralph']);

/** 从 exec 里尽力取调用信息；绝不抛错。 */
export function toolCallFrom(exec) {
  const fallback = { name: '', args: {}, path: undefined };
  try {
    if (exec === null || exec === undefined) return fallback;
    const name = typeof exec.name === 'string' ? exec.name : '';
    const rawArgs = exec.arguments ?? exec.args;
    const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : safeJson(rawArgs) ?? {};
    return { name, args, path: pathFromArgs(name, args) };
  } catch {
    return fallback;
  }
}

/**
 * 构造一条注入给模型的 user-role 消息。
 * 形状照抄官方 `createUserMessage({content, source})`（API-NOTES §5.3 / §6.3）：
 * 只 import node:crypto 生成 id，避免引入 @deepseek-ai/* 依赖。
 * @param {string} text
 * @returns {{id:string,role:'user',content:Array<{type:'text',text:string}>,source:object}}
 */
export function userMessage(text) {
  const body = truncate(text, 4000);
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: truncate(body, 120) },
  };
}

/**
 * 把一条要求塞回 agent（turn-stopping 里唯一能阻止本轮结束的手段）。
 * API-NOTES §6.3：`agent.steer(msg)` 投到 next-step；`ctx.steer()` 不存在。
 * 该方法缺失时退化为 followup / inject；全都不可用就只记录，不抛错。
 * @param {unknown} agent
 * @param {string} text
 * @returns {{ok:boolean,via?:string,error?:string}}
 */
export function steerAgent(agent, text) {
  let lastError;
  for (const method of ['steer', 'followup', 'inject']) {
    try {
      const fn = agent?.[method];
      if (typeof fn !== 'function') continue;
      fn.call(agent, userMessage(text));
      console.log(`[perse-proof] 已通过 agent.${method}() 注入一条要求`);
      return { ok: true, via: method };
    } catch (error) {
      lastError = errorText(error);
    }
  }
  console.log(`[perse-proof] 无法向 agent 注入要求（steer/followup/inject 都不可用）：${lastError ?? 'missing'}`);
  return { ok: false, error: lastError ?? 'missing' };
}

/**
 * 从会话日志里拼出「真实发生过的命令」列表，供结论的交叉核对使用。
 * 只取带命令原文的调用（bash/pwsh 之类），拿不到就返回空数组。
 * @param {unknown} session
 * @returns {Array<{name:string,command:string,callId?:string,turn?:number,step?:number}>}
 */
export function sessionToolCalls(session) {
  const out = [];
  try {
    if (session === undefined || session === null) return out;
    for (const event of eventsOf(session)) {
      if (event?.type !== 'tool/call') continue;
      const name = typeof event?.data?.name === 'string' ? event.data.name : '';
      const args = safeJson(event?.data?.arguments);
      const raw = args?.command ?? args?.cmd ?? args?.script;
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      out.push({
        name,
        command: raw,
        callId: event?.data?.callId,
        turn: event?.data?.turn,
        step: event?.data?.step,
      });
    }
  } catch {
    /* 忽略：拿不到就当没有记录 */
  }
  return out;
}

/** 读取一个可选的数字型字段。 */
export function numberOr(value, fallback = undefined) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
