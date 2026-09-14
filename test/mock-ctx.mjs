/**
 * perse-proof 测试用的 **假 ctx**（test double）。
 *
 * ⚠️ 这是假 ctx，**不是**真实 cordis Context。真实形状以 `docs/API-NOTES.md` 为准：
 *   - §3.0/§3.1  `ctx.tools.register(def) -> disposer`
 *                def 必须有 `execute(args, exec)`（**没有 `handler`**）；
 *                `parameters` 是**原始 JSON Schema**（`{type:'object',properties,required}`）；
 *                `output`（`{schema, render}`）是 `register()` 会校验的字段。
 *   - §4.1/§4.2  `ctx.systemPrompt.section({name, order, text, complete?}) -> disposer`；
 *                `getSectionOrder('TOOL_REPORT') === 2900`，拼错的名字返回 `undefined`（不抛）。
 *                §4.7 同名重复注册**会抛错**。
 *   - §5.1       `ctx.commands.register({name, description, input?, recordInput?, handler}) -> disposer`
 *                名字小写、不带 `/`；多余字段被静默丢弃。
 *   - §6.1       `ctx.on(name, fn, options?) -> disposer`；派发模式由派发点决定
 *                （`agent/pre-step` = waterfall，`agent/turn-stopping` = serial，`tools/result` = emit）。
 *   - §10.5/§10.6 可选依赖**必须** `ctx.get(name)` 判空；`ctx.missing` 未 inject 时会抛。
 *   - §11.1      `ctx.logger` 既是对象（`.info/.warn/.error/.debug`）也是可调用服务（`ctx.logger(name)`）。
 *
 * 设计取舍：
 *   - `tools.register` **不抛**，但会把契约违规（缺 `execute`、`parameters` 不是对象 JSON Schema、
 *     误用 `handler`）记进 `ctx.__spy.problems`，便于单个用例精确断言，而不至于把所有用例一起炸掉。
 *   - 所有注册都只**记录**，绝不触碰真实 DSH、真实端口或用户目录。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** API-NOTES §4.2 的 SECTION_ORDERS 片段（真实值；未导出的表，这里按实测值复刻）。 */
export const SECTION_ORDERS = {
  TOOL_REPORT: 2900,
  TOOL_SUBAGENT: 2800,
  DELIVERABLE_FILE_REFERENCES: 9000,
  HARNESS_SOURCE: 10000,
};

/** A5 冻结的 9 个工具名。 */
export const TOOL_NAMES = [
  'proof_fact_set',
  'proof_facts',
  'proof_criteria_freeze',
  'proof_criteria_amend',
  'proof_criteria_check',
  'proof_verify_run',
  'proof_allowlist_add',
  'proof_claim',
  'proof_claims',
];

/** 复刻真实 logger：既是对象（.info/.warn/.error/.debug），也是可调用服务（ctx.logger(name)）。 */
function makeLogger(entries) {
  const push = (level) => (...args) => {
    entries.push({ level, args });
  };
  return Object.assign(
    (name) => {
      const child = makeLogger(entries);
      child.__name = name;
      return child;
    },
    {
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      debug: push('debug'),
    },
  );
}

/**
 * 创建假 ctx。
 *
 * @param {object} [options]
 * @param {Record<string, boolean>} [options.capabilities]
 *        可选服务是否可用（默认全部可用）。`{tokenMeter:false}` ⇒ `ctx.get('tokenMeter')` 返回 undefined。
 *        始终可用的硬依赖：tools / systemPrompt / commands / logger。
 * @param {Record<string, number>} [options.sectionOrders] 覆盖 getSectionOrder 的返回值。
 * @param {boolean} [options.duplicateSectionThrows=true] 同名 section 重复注册是否抛错（真实行为：抛）。
 */
export function createMockCtx(options = {}) {
  const { capabilities = {}, sectionOrders = {}, duplicateSectionThrows = true } = options;

  /** @type {{tools:any[], sections:any[], commands:any[], listeners:Map<string,Function[]>, effects:any[], logs:any[], problems:string[]}} */
  const spy = {
    tools: [],
    sections: [],
    commands: [],
    listeners: new Map(),
    effects: [],
    logs: [],
    problems: [],
  };

  const dispose = () => {};

  const tools = {
    register(definition) {
      const def = definition ?? {};
      const name = typeof def.name === 'string' ? def.name : '';
      if (typeof def.execute !== 'function') {
        spy.problems.push(
          `tools.register(${name || '<no name>'}): 缺少 execute(args, exec)（API-NOTES §3.0：字段名是 execute，不是 handler）`,
        );
      }
      if (typeof def.handler === 'function' && typeof def.execute !== 'function') {
        spy.problems.push(`tools.register(${name}): 误用了 handler 字段（API-NOTES §3.5.1）`);
      }
      if (def.parameters === undefined || typeof def.parameters !== 'object' || def.parameters === null) {
        spy.problems.push(`tools.register(${name}): parameters 必须是原始 JSON Schema 对象`);
      } else if (def.parameters.type !== 'object') {
        spy.problems.push(`tools.register(${name}): parameters.type 应为 'object'（实际 ${String(def.parameters.type)}）`);
      }
      if (def.output === undefined || typeof def.output !== 'object' || typeof def.output.render !== 'function') {
        spy.problems.push(`tools.register(${name}): 缺少 output {schema, render}（真实 register() 会 TypeError，API-NOTES §3.0）`);
      }
      spy.tools.push(def);
      return dispose;
    },
    restrict() {
      return dispose;
    },
    guard() {
      return dispose;
    },
  };

  const systemPrompt = {
    section(section) {
      const name = section?.name;
      if (spy.sections.some((s) => s.name === name) && duplicateSectionThrows) {
        throw new Error(
          `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`,
        );
      }
      spy.sections.push(section);
      return dispose;
    },
    getSectionOrder(name) {
      if (Object.prototype.hasOwnProperty.call(sectionOrders, name)) return sectionOrders[name];
      return SECTION_ORDERS[name]; // 真实行为：拼错返回 undefined，不抛
    },
    getContextOrder() {
      return undefined;
    },
    variable() {
      return dispose;
    },
    context() {
      return dispose;
    },
  };

  const commands = {
    register(definition) {
      spy.commands.push(definition);
      return dispose;
    },
  };

  const logger = makeLogger(spy.logs);

  const sessionProjections = {
    register() {
      return dispose;
    },
    stateOf() {
      return undefined;
    },
    snapshot() {
      return { values: {} };
    },
    onChanged() {
      return dispose;
    },
  };

  const tokenMeter = {
    measure() {
      return { totalTokens: 0, surfaceTokens: 0, baseline: { kind: 'none', tokens: 0 } };
    },
    estimateMessage() {
      return 0;
    },
  };

  const goals = {
    get() {
      return undefined;
    },
    state() {
      return null;
    },
  };

  const registry = new Map([
    ['tools', tools],
    ['systemPrompt', systemPrompt],
    ['commands', commands],
    ['logger', logger],
    ['sessionProjections', sessionProjections],
    ['tokenMeter', tokenMeter],
    ['goals', goals],
  ]);

  const ctx = {
    tools,
    systemPrompt,
    commands,
    logger,
    /** 真实 ctx.get：未注册的 key 返回 undefined，不抛（API-NOTES §10.6）。 */
    get(name) {
      if (Object.prototype.hasOwnProperty.call(capabilities, name) && capabilities[name] === false) {
        return undefined;
      }
      return registry.get(name);
    },
    on(event, fn) {
      const list = spy.listeners.get(event) ?? [];
      list.push(fn);
      spy.listeners.set(event, list);
      return dispose;
    },
    effect(fn) {
      if (typeof fn !== 'function') throw new TypeError('ctx.effect() expects a function');
      const result = fn();
      spy.effects.push(result);
      return () => {
        try {
          if (typeof result === 'function') result();
        } catch {
          /* 假 ctx 的清理失败不影响测试 */
        }
      };
    },
    /** 测试专用：手动触发已记录的监听器。 */
    __emit(event, ...args) {
      const list = spy.listeners.get(event) ?? [];
      return Promise.all(list.map((fn) => fn(...args)));
    },
    /** 测试专用：waterfall 形态（`agent/pre-step` 那种 `(payload, next)`）。 */
    __emitWaterfall(event, payload, fallback) {
      const list = spy.listeners.get(event) ?? [];
      const next = async () => fallback;
      let chain = next;
      for (const fn of list) {
        const prev = chain;
        chain = () => fn(payload, prev);
      }
      return chain();
    },
    /** 测试专用：观察窗（注册记 / 日志 / 契约问题）。 */
    __spy: spy,
    __services: registry,
  };

  return ctx;
}

/** 建一个隔离的临时目录（不写用户目录）。 */
export function makeTmpDir(prefix = 'perse-proof-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 测后清理临时目录。 */
export function removeTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

/** 接管 console（插件按 A1 约定用 console.log 记诊断）。 */
export function captureConsole() {
  const lines = [];
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    original[level] = console[level];
    console[level] = (...args) => {
      lines.push({ level, text: args.map((a) => (typeof a === 'string' ? a : safeInspect(a))).join(' ') });
    };
  }
  return {
    lines,
    text() {
      return lines.map((l) => l.text).join('\n');
    },
    restore() {
      for (const [level, fn] of Object.entries(original)) console[level] = fn;
    },
  };
}

function safeInspect(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 跑一个可能抛错 / 返回 `{ok:false,errors}` 的调用，统一成可断言的结果。 */
export async function attempt(work) {
  try {
    return { threw: false, result: await work(), text: '' };
  } catch (error) {
    return { threw: true, error, text: errorText(error) };
  }
}

/** 该调用是否被拒（抛错，或返回 `{ok:false}` / 非空 `errors`）。 */
export function failed(outcome) {
  if (outcome.threw) return true;
  const r = outcome.result;
  if (r === null || typeof r !== 'object') return false;
  if (r.ok === false) return true;
  return Array.isArray(r.errors) && r.errors.length > 0;
}

/** 失败文本（抛错消息 / errors / message / error.message）。 */
export function failText(outcome) {
  if (outcome.threw) return errorText(outcome.error);
  return errorText(outcome.result);
}

function errorText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const parts = [];
  if (typeof value.message === 'string') parts.push(value.message);
  if (Array.isArray(value.errors)) {
    parts.push(value.errors.map((e) => (typeof e === 'string' ? e : errorText(e))).join(' | '));
  }
  if (value.error !== undefined) parts.push(errorText(value.error));
  if (parts.length === 0) parts.push(safeInspect(value));
  return parts.join(' :: ');
}

/** sha256 hex（与 API-NOTES §7.4 的真实路线一致：node:crypto）。 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** 写一个临时文件，返回其绝对路径。 */
export function writeTmpFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** 深度取值（断言嵌套结构时用）。 */
export function get(value, dotted, fallback) {
  let cur = value;
  for (const key of dotted.split('.')) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }
  return cur === undefined ? fallback : cur;
}
