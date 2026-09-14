/**
 * perse-proof · lib/index.js —— 插件入口。
 *
 * 接线原则（docs/ADDENDUM-A.md A1/A4 + docs/SPEC.md §0）：
 *   1. **不写 inject**：缺服务只会让 entry 永久 pending 并让 app-boot 拒绝启动；
 *      所有能力都在 apply 里用 `ctx.get(name)` 探测，缺了只降级并 console.log；
 *   2. 任何外部调用都包在 try/catch 里 —— 插件绝不能因自身异常中断会话；
 *   3. 所有能力都 `enabled:false` 时**什么都不注册**，直接干净返回（测试 T14）；
 *   4. 工具按 API-NOTES §3 的真实形状注册：`{name, description, parameters:<原始 JSON Schema>,
 *      output:{schema, render}, execute(args, exec)}` —— 没有 `handler`，`output` 是必填的，
 *      execute 返回**规范值**，模型可见文本由 `output.render` 产出。
 */

import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, resolveConfig } from './config.js';
import { createStore } from './store.js';
import { createLedger } from './ledger.js';
import { createCriteria } from './criteria.js';
import { createClaims } from './claims.js';
import { createReport } from './report.js';
import { createGates } from './gates.js';
import { createBudget } from './budget.js';
import { createCommands } from './commands.js';
import * as util from './util.js';

export const name = 'perse-proof';

// 不导出 Config：Config 必须是 Standard Schema（API-NOTES §10.3），
// 本插件零依赖、手写校验，配置在 apply 里通过 resolveConfig 自校验。

/** 工具返回值契约：`output.schema` 必填；模型看到的文本由 render 产出。 */
const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value?.text === 'string' && value.text !== '' ? value.text : '（没有可显示的内容）',
  }],
});

/** 取参数对象（非对象一律当空对象）。 */
function obj(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/** 取当前会话编号；拿不到就抛中文错误（工具层会转成 isError）。 */
function requireSession(exec) {
  const sessionId = util.sessionIdOf(exec?.agent);
  if (sessionId === undefined) throw new Error('这个工具必须在会话里使用（没有拿到会话编号）。');
  return sessionId;
}

/** 非空字符串校验。 */
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}不能为空。`);
  return value.trim();
}

/** 摘要短写。 */
function shortSha(value) {
  if (typeof value !== 'string' || value === '') return '无摘要';
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/** 时间戳 → 白话。 */
function timeText(ts) {
  return Number.isFinite(ts) ? new Date(ts).toLocaleString() : '时间未知';
}

/** 告警列表 → 一句中文。 */
function alertsNote(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return '';
  const details = alerts
    .map((alert) => (typeof alert?.detail === 'string' && alert.detail !== '' ? alert.detail : '有异常需要确认'))
    .join('；');
  return `\n注意：${details}`;
}

/** 一条事实的白话格式（工具返回用）。 */
function formatFact(key, item) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const kinds = evidence.map((entry) => {
    if (entry?.kind === 'file') return `文件 ${entry.path ?? '?'}`;
    if (entry?.kind === 'command') return `命令 ${entry.cmd ?? '?'}`;
    return '人工说明';
  });
  return `· ${key}：${item?.value ?? '（空）'}（来源：${item?.source === 'model' ? '模型自述' : '工具核对过'}，时间：${timeText(item?.at)}，证据：${kinds.join('；') || '无'}）`;
}

/**
 * 组装 9 个工具的定义（按可用模块裁剪）。
 * @param {{ledger:object|null, criteria:object|null, claims:object|null}} deps
 */
function buildToolDefinitions({ ledger, criteria, claims }) {
  const definitions = [];

  if (ledger !== null) {
    definitions.push({
      name: 'proof_fact_set',
      description: '登记一条可核验的事实并附证据（文件证据要带 sha256，命令证据要带退出码）。证据核对不上就不会写入。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '这条事实的名字，简短、可辨认' },
          value: { type: 'string', description: '这条事实的内容' },
          evidence: {
            type: 'array',
            description: '证据列表：文件 {kind:"file",path,sha256}；命令 {kind:"command",cmd,exitCode}；人工说明 {kind:"manual",note}',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                kind: { type: 'string', enum: ['file', 'command', 'manual'], description: '证据类型' },
                path: { type: 'string', description: '文件路径（文件证据）' },
                sha256: { type: 'string', description: '文件内容的 sha256（文件证据）' },
                cmd: { type: 'string', description: '命令原文（命令证据）' },
                exitCode: { type: 'integer', description: '退出码（命令证据）' },
                outputSha256: { type: 'string', description: '命令输出的 sha256（可选）' },
                note: { type: 'string', description: '人工说明（人工证据）' },
              },
              required: ['kind'],
            },
          },
          note: { type: 'string', description: '备注（可选）' },
        },
        required: ['key', 'value'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const input = obj(args);
        const result = ledger.setFact({
          sessionId,
          key: input.key,
          value: input.value,
          evidence: input.evidence,
          note: input.note,
          source: 'tool',
        });
        if (result?.ok !== true) {
          const reasons = Array.isArray(result?.errors) && result.errors.length > 0 ? result.errors.join('；') : '原因不明';
          throw new Error(`这条事实没有记下来：${reasons}`);
        }
        const downgraded = result?.downgraded === true ? '（部分证据没能核对上，已按「部分验证」处理）' : '';
        return { ok: true, text: `已记下事实「${input.key}」。${downgraded}` };
      },
    });

    definitions.push({
      name: 'proof_facts',
      description: '读回本会话登记过的事实台账（可只看一条）。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '只看这一条（可选，不填就列全部）' } },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const all = ledger.facts(sessionId) ?? {};
        const key = obj(args).key;
        if (typeof key === 'string' && key.trim() !== '') {
          const wanted = key.trim();
          const item = all[wanted];
          if (item === undefined) {
            const names = Object.keys(all);
            return { ok: false, text: `台账里没有叫「${wanted}」的事实。现在有的是：${names.join('、') || '（空）'}` };
          }
          return { ok: true, text: formatFact(wanted, item) };
        }
        const names = Object.keys(all);
        if (names.length === 0) return { ok: true, text: '事实台账还是空的：还没有登记过任何事实。' };
        return { ok: true, text: [`共 ${names.length} 条：`, ...names.map((item) => formatFact(item, all[item]))].join('\n') };
      },
    });
  }

  if (criteria !== null) {
    definitions.push({
      name: 'proof_criteria_freeze',
      description: '把这一轮的验收判据冻结成新版本（内容摘要会剔除临时路径、端口、时间戳等易变量）。判据定了就不许偷偷改。',
      parameters: {
        type: 'object',
        properties: {
          criteria: {
            type: 'array',
            description: '判据列表',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', description: '判据编号' },
                desc: { type: 'string', description: '这条判据要保证什么' },
                check: { type: 'string', description: '怎么检查（命令或可机械执行的步骤）' },
              },
              required: ['id', 'desc', 'check'],
            },
          },
          taskId: { type: 'string', description: '任务名（可选，默认 default）' },
          executor: {
            type: 'object',
            additionalProperties: true,
            properties: {
              path: { type: 'string', description: '跑判据的执行器文件' },
              sha256: { type: 'string', description: '执行器内容的 sha256（可选）' },
            },
            description: '执行器（可选）',
          },
          artifacts: { type: 'array', items: { type: 'string' }, description: '判据涉及的产物文件（可选）' },
        },
        required: ['criteria'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const input = obj(args);
        if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
          throw new Error('至少要给一条判据（id、说明、怎么检查），否则冻结没有意义。');
        }
        const result = criteria.freeze({
          sessionId,
          taskId: input.taskId,
          criteria: input.criteria,
          executor: input.executor,
          artifacts: input.artifacts,
        });
        if (result?.ok === false) {
          throw new Error('判据没能存下来（写文件失败），请稍后重试。');
        }
        const task = result?.taskId ?? input.taskId ?? 'default';
        return {
          ok: true,
          text: `判据已冻结：任务「${task}」第 ${result?.revision ?? '?'} 版，内容摘要 ${shortSha(result?.contentSha256)}。${alertsNote(result?.alerts)}`,
        };
      },
    });

    definitions.push({
      name: 'proof_criteria_amend',
      description: '修改已冻结的判据。必须写清修改原因；如果是在一次失败之后修改，会被单独标记出来。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务名（可选，默认 default）' },
          criteria: {
            type: 'array',
            description: '修改后的完整判据列表',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', description: '判据编号' },
                desc: { type: 'string', description: '这条判据要保证什么' },
                check: { type: 'string', description: '怎么检查' },
              },
              required: ['id', 'desc', 'check'],
            },
          },
          reason: { type: 'string', description: '为什么必须改（必填）' },
        },
        required: ['criteria', 'reason'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const input = obj(args);
        const reason = requireText(input.reason, '修改原因');
        if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
          throw new Error('修改后的判据不能是空的。');
        }
        const result = criteria.amend({ sessionId, taskId: input.taskId, criteria: input.criteria, reason });
        const task = result?.taskId ?? input.taskId ?? 'default';
        const afterFailure = result?.afterFailure === true ? '\n注意：这次修改发生在一次失败之后，已经留痕，不会被当成无事发生。' : '';
        return {
          ok: true,
          text: `判据已更新：任务「${task}」第 ${result?.revision ?? '?'} 版，内容摘要 ${shortSha(result?.contentSha256)}。原因已记下：${reason}${afterFailure}`,
        };
      },
    });

    definitions.push({
      name: 'proof_criteria_check',
      description: '只读查看当前判据是哪一版、改过几次、每次改动是不是发生在一轮失败之后。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务名（可选，不填就列全部）' } },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const wanted = obj(args).taskId;
        const listing = criteria.list(sessionId) ?? {};
        const tasks = listing?.tasks ?? {};
        const names = Object.keys(tasks);
        if (names.length === 0) return { ok: true, text: '还没有冻结过任何判据。' };
        const picked = typeof wanted === 'string' && wanted.trim() !== '' ? names.filter((item) => item === wanted.trim()) : names;
        if (picked.length === 0) {
          return { ok: false, text: `没有叫「${wanted}」的任务。现在有：${names.join('、')}` };
        }
        const lines = [];
        for (const task of picked) {
          const entry = tasks[task] ?? {};
          const revisions = Array.isArray(entry.revisions) ? entry.revisions : [];
          const current = criteria.current(sessionId, task);
          lines.push(`任务「${task}」：当前第 ${current ?? revisions.length} 版，共 ${revisions.length} 次冻结/修改。`);
          for (const revision of revisions.slice(-5)) {
            const data = revision?.data ?? revision ?? {};
            const afterFailure = data.afterFailure === true ? '（这次改动发生在一次失败之后）' : '';
            lines.push(`  · 第 ${data.revision ?? '?'} 版，内容摘要 ${shortSha(data.contentSha256)}${afterFailure}`);
          }
        }
        return { ok: true, text: lines.join('\n') };
      },
    });

    definitions.push({
      name: 'proof_verify_run',
      description: '登记一次判据运行的结果（通过/失败/跳过）。如果判据在两次运行之间被改过，会明确指出这次结果不能和上次直接比。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务名（可选，默认 default）' },
          command: { type: 'string', description: '跑的命令（可选）' },
          executorPath: { type: 'string', description: '执行器文件路径（可选）' },
          exitCode: { type: 'integer', description: '退出码（可选）' },
          pass: { type: 'integer', description: '通过条数' },
          fail: { type: 'integer', description: '失败条数' },
          skip: { type: 'integer', description: '跳过条数' },
          outputSha256: { type: 'string', description: '命令输出的 sha256（可选）' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const input = obj(args);
        const result = criteria.recordRun({
          sessionId,
          taskId: input.taskId,
          command: input.command,
          executorPath: input.executorPath,
          exitCode: input.exitCode,
          pass: input.pass,
          fail: input.fail,
          skip: input.skip,
          outputSha256: input.outputSha256,
        });
        const task = result?.taskId ?? input.taskId ?? 'default';
        const counts = `通过 ${util.intOr(input.pass, 0)} / 失败 ${util.intOr(input.fail, 0)} / 跳过 ${util.intOr(input.skip, 0)}`;
        const drift = result?.drift;
        const driftNote = drift
          ? `\n注意：判据在这次运行之前被改动过（从 ${shortSha(drift.from)} 变成 ${shortSha(drift.to)}）`
            + `${drift.afterFailure === true ? '，而且改动发生在上一次失败之后' : ''}，所以这次结果不能和上一次直接比较。`
          : '';
        return { ok: true, text: `已记录任务「${task}」的一次判据运行：${counts}。${driftNote}` };
      },
    });

    definitions.push({
      name: 'proof_allowlist_add',
      description: '登记一条「放宽」记录（比如某个已知问题暂时豁免）。必须写清原因和它对应哪次失败，避免出现没有边界的永久放宽。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '涉及的文件（必填）' },
          pattern: { type: 'string', description: '放宽的匹配内容（必填）' },
          reason: { type: 'string', description: '为什么可以放宽（必填）' },
          failureRef: { type: 'string', description: '对应哪次失败（必填，例如某次运行或某条记录）' },
          upstreamId: { type: 'string', description: '上游单号或链接（可选）' },
          reviewBy: { type: 'string', description: '谁在什么时候复核（可选）' },
        },
        required: ['file', 'pattern', 'reason', 'failureRef'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const input = obj(args);
        const file = requireText(input.file, '涉及的文件');
        const pattern = requireText(input.pattern, '放宽的匹配内容');
        const reason = requireText(input.reason, '放宽原因');
        const failureRef = requireText(input.failureRef, '对应的失败记录');
        const result = criteria.addAllowlist({
          sessionId,
          file,
          pattern,
          reason,
          failureRef,
          upstreamId: input.upstreamId,
          reviewBy: input.reviewBy,
        });
        if (result?.ok === false) throw new Error('这条放宽记录没能存下来，请稍后重试。');
        return {
          ok: true,
          text: `已登记放宽记录：${file} 里的 ${pattern}。原因：${reason}；对应失败：${failureRef}`
            + `${input.reviewBy ? `；复核：${input.reviewBy}` : '（还没写复核人和时间，建议补上）'}`,
        };
      },
    });
  }

  if (claims !== null) {
    definitions.push({
      name: 'proof_claim',
      description: '登记一条结论并说明证据。要标成「已验证」，就必须给出真实存在的文件（含 sha256）或本会话真实跑过的命令（含退出码）；对不上就只能标「部分验证」。',
      parameters: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: '结论内容（必填）' },
          level: { type: 'string', enum: ['verified', 'partial', 'unverified'], description: '可信级别：已验证 / 部分验证 / 未验证' },
          evidence: {
            type: 'array',
            description: '证据列表（必填）',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                kind: { type: 'string', enum: ['file', 'command', 'manual'], description: '证据类型' },
                path: { type: 'string', description: '文件路径（文件证据）' },
                sha256: { type: 'string', description: '文件内容的 sha256（文件证据）' },
                cmd: { type: 'string', description: '命令原文（命令证据）' },
                exitCode: { type: 'integer', description: '退出码（命令证据）' },
                outputSha256: { type: 'string', description: '命令输出的 sha256（可选）' },
                note: { type: 'string', description: '人工说明（人工证据）' },
              },
              required: ['kind'],
            },
          },
          scope: { type: 'string', description: '这条结论的适用范围（可选）' },
        },
        required: ['claim', 'level', 'evidence'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const input = obj(args);
        const claim = requireText(input.claim, '结论内容');
        const level = typeof input.level === 'string' ? input.level : 'unverified';
        if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
          throw new Error('必须给出至少一条证据；没有任何证据的结论请标成「未验证」。');
        }
        if (level === 'verified' && input.evidence.every((entry) => entry?.kind === 'manual')) {
          throw new Error('只有人工说明不能算「已验证」。请补上文件证据（含 sha256）或真实跑过的命令（含退出码），否则请标成「部分验证」。');
        }
        const result = claims.record({
          sessionId,
          claim,
          level,
          evidence: input.evidence,
          scope: input.scope,
          sessionToolCalls: util.sessionToolCalls(util.sessionOf(exec?.agent)),
        });
        if (result?.ok === false) {
          const reasons = Array.isArray(result?.errors) && result.errors.length > 0 ? result.errors.join('；') : '证据对不上';
          throw new Error(`这条结论没有登记成「已验证」：${reasons}`);
        }
        const finalLevel = result?.level ?? level;
        const checked = Array.isArray(result?.checked) ? result.checked.length : 0;
        const notes = Array.isArray(result?.notes) && result.notes.length > 0 ? `\n补充说明：${result.notes.join('；')}` : '';
        return {
          ok: true,
          text: `已登记结论（级别：${finalLevel === 'verified' ? '已验证' : finalLevel === 'partial' ? '部分验证' : '未验证'}，核对 ${checked} 项）：${claim}${notes}`,
        };
      },
    });

    definitions.push({
      name: 'proof_claims',
      description: '列出本会话登记过的全部结论与核对结果。',
      parameters: { type: 'object', properties: {} },
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        const sessionId = requireSession(exec);
        const list = claims.list(sessionId);
        if (!Array.isArray(list) || list.length === 0) return { ok: true, text: '本会话还没有登记过任何结论。' };
        const lines = [`共 ${list.length} 条结论：`];
        for (const item of list.slice(-20)) {
          const data = item?.data ?? item ?? {};
          const level = data.level === 'verified' ? '已验证' : data.level === 'partial' ? '部分验证' : '未验证';
          const checked = Array.isArray(data.checked) ? data.checked.length : 0;
          lines.push(`· [${level}] ${data.claim ?? '（没有写结论内容）'}（核对 ${checked} 项，${timeText(data.at ?? item?.ts)}）`);
        }
        return { ok: true, text: lines.join('\n') };
      },
    });
  }

  return definitions;
}

/**
 * 插件入口。
 * @param {any} ctx cordis 上下文
 * @param {any} rawConfig 用户配置（手写校验，绝不抛错）
 */
export function apply(ctx, rawConfig) {
  const disposers = [];
  console.log('[perse-proof] apply: 开始接线');

  let config = DEFAULTS;
  try {
    const resolved = resolveConfig(rawConfig);
    if (resolved !== null && typeof resolved === 'object' && resolved.config !== undefined) config = resolved.config;
    for (const warning of resolved?.warnings ?? []) console.log(`[perse-proof] 配置提示：${warning}`);
  } catch (error) {
    console.log(`[perse-proof] 配置解析失败，改用内置默认值：${util.errorText(error)}`);
    config = DEFAULTS;
  }

  const on = (group) => config?.[group]?.enabled === true;
  const reportEnabled = on('report');
  const jargonEnabled = on('jargon');
  const claimsEnabled = on('claims');
  const criteriaEnabled = on('criteria');
  const ledgerEnabled = on('ledger');
  const budgetEnabled = on('budget');
  const completionGateEnabled = claimsEnabled && config?.claims?.gateOnCompletionClaim !== false;
  const anyEnabled = reportEnabled || jargonEnabled || claimsEnabled || criteriaEnabled || ledgerEnabled || budgetEnabled;

  // —— 全关：什么都不注册，干净退出（测试 T14）——
  if (!anyEnabled) {
    console.log('[perse-proof] 所有能力都已关闭，不注册任何工具 / 提示词段 / 监听');
    return undefined;
  }

  const logger = util.serviceOf(ctx, 'logger');
  const rootDir = typeof process.env.PERSE_PROOF_HOME === 'string' && process.env.PERSE_PROOF_HOME.trim() !== ''
    ? process.env.PERSE_PROOF_HOME.trim()
    : path.join(os.homedir(), '.dsh', 'proof');

  // —— 服务接线：用 cordis 的 `ctx.inject(deps, cb)`，**不要**在 apply 时刻 ctx.get() ——
  // 真机教训：`ctx.get('tools')` 只反映「此刻已就绪」，某些组合里 tools 由更晚就绪的
  // 插件提供 ⇒ apply 时拿不到、工具/命令全部漏注册。`ctx.inject` 是动态依赖：服务就绪后
  // 才执行回调，且它跑在 child fiber 上，**不会**阻塞本插件激活（app-boot 只审计 loader entry）。
  const canInject = typeof ctx?.inject === 'function';

  /**
   * 等服务就绪后接线；拿不到 `inject` 时退回 `ctx.get()` 即时探测（假 ctx / 老版本）。
   * @param {string[]} deps 依赖的服务名
   * @param {(scope:any)=>void} callback 拿到服务后做注册
   * @param {{missingLog?:string}} [options] 即时探测失败时打印的中文降级日志
   */
  function withService(deps, callback, options = {}) {
    const { missingLog } = options;
    if (canInject) {
      try {
        ctx.inject(deps, (scoped) => {
          try {
            callback(scoped);
          } catch (error) {
            console.log(`[perse-proof] 接线 ${deps.join('+')} 时出错：${util.errorText(error)}`);
          }
        });
        return;
      } catch (error) {
        console.log(`[perse-proof] ctx.inject(${deps.join('+')}) 不可用，退回即时探测：${util.errorText(error)}`);
      }
    }
    const scope = { get: (serviceName) => util.serviceOf(ctx, serviceName) };
    const missing = [];
    for (const dep of deps) {
      const service = util.serviceOf(ctx, dep);
      if (service === undefined) missing.push(dep);
      else scope[dep] = service;
    }
    if (missing.length > 0) {
      if (missingLog !== undefined) console.log(`[perse-proof] ${missingLog}`);
      return;
    }
    callback(scope);
  }

  /** 可选能力：探测不到只降级，不影响主功能（测试 T13）。 */
  const optionalCapabilities = [
    ['tokenMeter', '按轮 token 统计'],
    ['sessionProjections', '会话投影读取'],
    ['goals', '目标轮次预算'],
  ];
  const optional = { tokenMeter: undefined, sessionProjections: undefined, goals: undefined };
  for (const [serviceName, purpose] of optionalCapabilities) {
    withService([serviceName], (scope) => {
      optional[serviceName] = scope[serviceName];
      console.log(`[perse-proof] 可选能力 ${serviceName} 已接入（${purpose}）`);
    }, { missingLog: `降级：未找到 ${serviceName}，相关统计/投影不可用` });
  }

  function safeCreate(label, factory) {
    try {
      return factory();
    } catch (error) {
      console.log(`[perse-proof] ${label}初始化失败，相关功能关闭：${util.errorText(error)}`);
      return null;
    }
  }

  function safeRun(label, fn) {
    try {
      return fn();
    } catch (error) {
      console.log(`[perse-proof] ${label}失败：${util.errorText(error)}`);
      return undefined;
    }
  }

  function onEvent(eventName, listener) {
    try {
      if (typeof ctx?.on !== 'function') {
        console.log(`[perse-proof] 这个环境不支持监听 ${eventName}，跳过`);
        return false;
      }
      const off = ctx.on(eventName, listener);
      if (typeof off === 'function') disposers.push(off);
      return true;
    } catch (error) {
      console.log(`[perse-proof] 监听 ${eventName} 失败：${util.errorText(error)}`);
      return false;
    }
  }

  // —— 1. 记录仓库 ——
  const needsStore = ledgerEnabled || criteriaEnabled || claimsEnabled || budgetEnabled;
  const store = needsStore ? safeCreate('记录仓库', () => createStore({ rootDir, logger })) : null;

  // —— 2. 各业务模块（按开关创建，关掉的传 null）——
  const ledger = ledgerEnabled ? safeCreate('台账', () => createLedger({ store, config, logger })) : null;
  const criteria = criteriaEnabled ? safeCreate('判据', () => createCriteria({ store, config, logger })) : null;
  const claims = claimsEnabled ? safeCreate('结论核对', () => createClaims({ store, config, logger })) : null;
  const gates = (jargonEnabled || completionGateEnabled)
    ? safeCreate('闸门', () => createGates({ config, logger, store, claims }))
    : null;
  const budget = budgetEnabled ? safeCreate('成本观测', () => createBudget({ config, logger, store })) : null;

  // —— 3. 9 个工具（按可用模块裁剪；等服务就绪后再注册）——
  withService(['tools'], (scope) => {
    const tools = scope.tools;
    if (tools === undefined || typeof tools.register !== 'function') {
      console.log('[perse-proof] 缺少工具注册能力，跳过全部工具（其余功能不受影响）');
      return;
    }
    const registeredTools = [];
    for (const definition of buildToolDefinitions({ ledger, criteria, claims })) {
      try {
        const dispose = tools.register(definition);
        if (typeof dispose === 'function') disposers.push(dispose);
        registeredTools.push(definition.name);
      } catch (error) {
        console.log(`[perse-proof] 注册工具 ${definition.name} 失败：${util.errorText(error)}`);
      }
    }
    console.log(`[perse-proof] 已注册 ${registeredTools.length} 个工具：${registeredTools.join(', ') || '（无）'}`);
  }, { missingLog: '缺少工具注册能力，跳过全部工具（其余功能不受影响）' });

  // —— 4. 汇报契约提示词段（order 2900；等服务就绪后再注册）——
  if (reportEnabled) {
    withService(['systemPrompt'], (scope) => {
      const report = safeCreate('汇报契约', () => createReport({ ctx: scope, config, logger }));
      safeRun('注册汇报契约段', () => report?.install());
    }, { missingLog: '缺少系统提示词能力，跳过汇报契约段（其余功能不受影响）' });
  }

  // —— 5. 工具调用观测：台账（待办丢项 / 写放大）+ 派发预算 ——
  const todoDropOn = config?.ledger?.todoDropDetect !== false;
  const writeAmplifyOn = util.intOr(config?.ledger?.writeAmplifyThreshold, 8) > 0;
  if ((ledger !== null && (todoDropOn || writeAmplifyOn)) || (budget !== null && config?.budget?.dispatchBudgetCheck !== false)) {
    onEvent('tools/result', (exec, result) => {
      try {
        const sessionId = util.sessionIdOf(exec?.agent);
        if (sessionId === undefined) return;
        const call = util.toolCallFrom(exec);
        if (ledger !== null && (todoDropOn || writeAmplifyOn)) {
          const outcome = ledger.noteToolCall({ sessionId, name: call.name, args: call.args, toolResult: result });
          const inject = typeof outcome?.inject === 'string' && outcome.inject !== '' ? outcome.inject : null;
          if (inject !== null) util.steerAgent(exec?.agent, inject);
        }
        if (budget !== null && util.DISPATCH_TOOLS.includes(call.name)) {
          const prompt = [call.args?.prompt, call.args?.objective, call.args?.description].find((item) => typeof item === 'string') ?? '';
          budget.noteDispatch({ sessionId, tool: call.name, prompt });
        }
      } catch (error) {
        console.log(`[perse-proof] 工具调用观测出错（忽略）：${util.errorText(error)}`);
      }
    });
  }

  // —— 6. 闸门 + 按轮成本：都在 agent/turn-stopping（serial，只能靠 agent.steer 干预）——
  const factCounts = new Map();
  function ledgerWritesDelta(sessionId) {
    try {
      const records = store?.read?.(sessionId);
      if (!Array.isArray(records)) return 0;
      const total = records.filter((record) => record?.type === 'fact').length;
      const previous = factCounts.get(sessionId) ?? 0;
      factCounts.set(sessionId, total);
      return Math.max(0, total - previous);
    } catch {
      return 0;
    }
  }

  if (gates !== null || budget !== null) {
    onEvent('agent/turn-stopping', async ({ agent, turn } = {}) => {
      try {
        const session = util.sessionOf(agent);
        const sessionId = util.sessionIdOf(agent);
        if (sessionId === undefined) return;
        const text = util.lastAssistantText(agent, turn);
        const turnKey = `${sessionId}#${Number.isFinite(turn) ? turn : '?'}`;

        if (budget !== null) {
          const stats = util.turnStats(session, turn);
          let tokens = stats.tokens;
          // tokenMeter 是可选的：拿不到就按「未知」处理，不编数字（测试 T13）。
          const meter = optional.tokenMeter;
          if (tokens === undefined && meter !== undefined && meter !== null) {
            try {
              const measured = meter.measure?.(session);
              if (Number.isFinite(measured?.totalTokens)) tokens = measured.totalTokens;
            } catch (error) {
              console.log(`[perse-proof] 读取 token 用量失败（按未知处理）：${util.errorText(error)}`);
            }
          }
          const outcome = budget.noteTurn({
            sessionId,
            tokens,
            toolCalls: stats.toolCalls,
            newArtifacts: stats.newArtifacts,
            ledgerWrites: ledgerWritesDelta(sessionId),
          });
          for (const alert of outcome?.alerts ?? []) {
            if (typeof alert?.message === 'string' && alert.message !== '') util.steerAgent(agent, alert.message);
          }
        }

        if (gates !== null) {
          const verdict = gates.evaluate({ sessionId, text, turnKey });
          if (verdict?.steer?.message) util.steerAgent(agent, verdict.steer.message);
        }
      } catch (error) {
        console.log(`[perse-proof] turn-stopping 处理出错（忽略，不影响收尾）：${util.errorText(error)}`);
      }
    });
  }

  // —— 7. /proof 命令（等服务就绪后再注册）——
  withService(['commands'], (scope) => {
    const commands = safeCreate('命令', () => createCommands({ ctx: scope, config, logger, store, ledger, criteria, claims, budget, gates }));
    safeRun('注册 /proof 命令', () => commands?.install());
  }, { missingLog: '缺少命令注册能力，/proof 不可用（其余功能不受影响）' });

  console.log('[perse-proof] apply: 接线完成');

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* 卸载时的异常一律忽略 */
      }
    }
  };
}
