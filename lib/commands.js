/**
 * perse-proof · lib/commands.js
 *
 * `/proof` 斜杠命令（docs/SPEC.md §3.7）。
 * 依据 API-NOTES §5：`ctx.commands.register({name, description, input?, recordInput?, handler})`，
 * name 小写不带 `/`，handler 入参是 `{commandId, agent, rawInput, attachments, signal}`，
 * 返回值 `{kind:'success', text}` / `{kind:'error', text}`（**不要 throw**）。
 * 所有输出都是中文白话，不出现本插件内部字段名。
 */

import { serviceOf, sessionIdOf, errorText, truncate } from './util.js';

/** 告警类型 → 白话（不暴露内部字段名）。 */
const ALERT_LABELS = {
  'criteria-drift': '判据被改动',
  'todo-drop': '清单丢项',
  'write-amplify': '同一个文件反复重写',
  'claim-unbacked': '结论缺证据',
  jargon: '代号没解释',
  'no-progress': '多轮没有新进展',
  'dispatch-overrun': '派发超出声明预算',
};

/** 结论级别 → 白话。 */
const LEVEL_LABELS = { verified: '已验证', partial: '部分验证', unverified: '未验证' };

/** 来源 → 白话。 */
const SOURCE_LABELS = { tool: '工具核对过', model: '模型自述' };

const HELP_TEXT = [
  '可用指令：',
  '· /proof status —— 一句话总览 + 告警明细',
  '· /proof facts [名字] —— 看事实台账（可只看一条）',
  '· /proof criteria [任务名] —— 看判据冻结版本与改动记录',
  '· /proof claims —— 看本会话登记过的结论与核对结果',
  '· /proof alerts —— 只看告警',
  '· /proof help —— 这份说明',
].join('\n');

/** 把时间戳写成可读文本。 */
function timeText(ts) {
  if (!Number.isFinite(ts)) return '时间未知';
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '时间未知';
  }
}

/** 短摘要，便于人眼看。 */
function shortSha(value) {
  if (typeof value !== 'string' || value === '') return '无摘要';
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function alertLine(record) {
  const data = record?.data ?? {};
  const label = ALERT_LABELS[data.kind] ?? '异常情况';
  const detail = typeof data.detail === 'string' && data.detail !== '' ? data.detail : '（没有更多说明）';
  return `· [${label}] ${detail}（${timeText(data.at ?? record?.ts)}）`;
}

/**
 * @param {{ctx:unknown, config?:object, store?:object, ledger?:object, criteria?:object,
 *          claims?:object, budget?:object, gates?:object}} deps
 */
export function createCommands({ ctx, store, ledger, criteria, claims, budget, gates } = {}) {
  /** 读全部记录（失败按空处理）。 */
  function recordsOf(sessionId) {
    try {
      const list = store?.read?.(sessionId);
      return Array.isArray(list) ? list : [];
    } catch (error) {
      console.log(`[perse-proof] 读取记录失败（按空处理）：${errorText(error)}`);
      return [];
    }
  }

  function safeCall(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      console.log(`[perse-proof] 读取状态失败（按空处理）：${errorText(error)}`);
      return fallback;
    }
  }

  function alertsOf(records) {
    return records.filter((record) => record?.type === 'alert');
  }

  function evidenceCount(records) {
    let count = 0;
    for (const record of records) {
      if (record?.type === 'claim' || record?.type === 'fact') {
        const list = record?.data?.evidence;
        if (Array.isArray(list)) count += list.length;
      }
    }
    return count;
  }

  /** /proof status */
  function statusText(sessionId) {
    const records = recordsOf(sessionId);
    const facts = safeCall(() => ledger?.facts?.(sessionId) ?? {}, {});
    const taskMap = safeCall(() => criteria?.list?.(sessionId)?.tasks ?? {}, {});
    const alertList = alertsOf(records);
    const headings = [
      `判据 ${Object.keys(taskMap).length} 个任务`,
      `台账 ${Object.keys(facts).length} 条`,
      `证据 ${evidenceCount(records)} 条`,
      `告警 ${alertList.length} 条`,
    ];
    const lines = [headings.join(' / ')];
    if (alertList.length === 0) {
      lines.push('告警：暂无告警。');
    } else {
      lines.push(`告警明细（最近 ${Math.min(10, alertList.length)} 条）：`);
      for (const record of alertList.slice(-10)) lines.push(alertLine(record));
    }
    if (budget !== undefined && budget !== null) {
      const state = safeCall(() => budget.status(sessionId), { enabled: false });
      lines.push(state?.enabled === true
        ? `成本观测：已开启，本会话已统计 ${state.rounds} 轮，连续无进展 ${state.noProgressStreak} 轮。`
        : '成本观测：未开启（默认关闭）。');
    }
    return lines.join('\n');
  }

  /** /proof facts [key] */
  function factsText(sessionId, key) {
    const facts = safeCall(() => ledger?.facts?.(sessionId) ?? {}, {});
    const keys = Object.keys(facts);
    if (keys.length === 0) return '事实台账还是空的：还没有登记过任何事实。';
    if (key !== undefined && key !== '') {
      const item = facts[key];
      if (item === undefined) return `台账里没有叫「${key}」的事实。当前有 ${keys.length} 条：${keys.join('、')}`;
      return formatFact(key, item);
    }
    return [`共 ${keys.length} 条事实：`, ...keys.map((name) => formatFact(name, facts[name]))].join('\n');
  }

  function formatFact(key, item) {
    const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
    const bits = [
      `· ${key}：${item?.value ?? '（空）'}`,
      `来源：${SOURCE_LABELS[item?.source] ?? '来源不明'}`,
      `时间：${timeText(item?.at)}`,
    ];
    if (evidence.length > 0) {
      const kinds = evidence.map((e) => e?.kind === 'file' ? `文件 ${e.path ?? '?'}` : e?.kind === 'command' ? `命令 ${e.cmd ?? '?'}` : '人工说明');
      bits.push(`证据：${kinds.join('；')}`);
    } else {
      bits.push('证据：无');
    }
    if (typeof item?.note === 'string' && item.note !== '') bits.push(`备注：${item.note}`);
    return bits.join('｜');
  }

  /** /proof criteria [taskId] */
  function criteriaText(sessionId, taskId) {
    const listing = safeCall(() => criteria?.list?.(sessionId) ?? {}, {});
    const tasks = listing?.tasks ?? {};
    const names = Object.keys(tasks);
    if (names.length === 0) return '还没有冻结过任何判据。';
    const wanted = taskId !== undefined && taskId !== '' ? names.filter((name) => name === taskId) : names;
    if (wanted.length === 0) return `没有叫「${taskId}」的任务。当前有 ${names.length} 个：${names.join('、')}`;
    const lines = [];
    for (const name of wanted) {
      const entry = tasks[name] ?? {};
      const revisions = Array.isArray(entry.revisions) ? entry.revisions : [];
      const current = safeCall(() => criteria?.current?.(sessionId, name) ?? null, null);
      lines.push(`任务「${name}」：当前第 ${current ?? revisions.length} 版，共 ${revisions.length} 次冻结/修改。`);
      for (const revision of revisions.slice(-5)) {
        const data = revision?.data ?? revision ?? {};
        const sha = shortSha(data.contentSha256 ?? data.sha256);
        const marked = data.afterFailure === true ? '（改动发生在一次失败之后）' : '';
        const reason = typeof data.reason === 'string' && data.reason !== '' ? `，原因：${data.reason}` : '';
        lines.push(`  · 第 ${data.revision ?? '?'} 版，内容摘要 ${sha}${marked}${reason}`);
      }
      const runs = Array.isArray(entry.runs) ? entry.runs : [];
      if (runs.length > 0) {
        const last = runs[runs.length - 1]?.data ?? runs[runs.length - 1] ?? {};
        lines.push(`  · 最近一次运行：通过 ${last.pass ?? 0} / 失败 ${last.fail ?? 0} / 跳过 ${last.skip ?? 0}（${timeText(last.at)}）`);
      }
    }
    return lines.join('\n');
  }

  /** /proof claims */
  function claimsText(sessionId) {
    const list = safeCall(() => claims?.list?.(sessionId) ?? [], []);
    if (!Array.isArray(list) || list.length === 0) return '本会话还没有登记过结论。';
    const lines = [`共 ${list.length} 条结论：`];
    for (const item of list.slice(-20)) {
      const data = item?.data ?? item ?? {};
      const level = LEVEL_LABELS[data.level] ?? '（级别不明）';
      const checked = Array.isArray(data.checked) ? data.checked.length : 0;
      lines.push(`· [${level}] ${data.claim ?? '（没有写结论内容）'}（核对 ${checked} 项，${timeText(data.at ?? item?.ts)}）`);
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        lines.push(`    问题：${data.errors.join('；')}`);
      }
    }
    return lines.join('\n');
  }

  /** /proof alerts */
  function alertsText(sessionId) {
    const list = alertsOf(recordsOf(sessionId));
    if (list.length === 0) return '告警：暂无告警。';
    return [`共 ${list.length} 条告警：`, ...list.slice(-30).map(alertLine)].join('\n');
  }

  /** 命令处理器。 */
  function handler(invocation) {
    try {
      const sessionId = sessionIdOf(invocation?.agent);
      const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
      const [sub = 'status', ...rest] = raw === '' ? [] : raw.split(/\s+/);
      const arg = rest.join(' ').trim();
      if (sessionId === undefined) {
        return { kind: 'error', text: '这个命令只能在会话里使用（拿不到会话编号）。' };
      }
      switch (sub) {
        case 'status':
          return { kind: 'success', text: statusText(sessionId) };
        case 'facts':
          return { kind: 'success', text: factsText(sessionId, arg) };
        case 'criteria':
          return { kind: 'success', text: criteriaText(sessionId, arg) };
        case 'claims':
          return { kind: 'success', text: claimsText(sessionId) };
        case 'alerts':
          return { kind: 'success', text: alertsText(sessionId) };
        case 'help':
          return { kind: 'success', text: HELP_TEXT };
        default:
          return { kind: 'error', text: `看不懂「${truncate(sub, 40)}」这个指令。\n${HELP_TEXT}` };
      }
    } catch (error) {
      console.log(`[perse-proof] /proof 执行出错：${errorText(error)}`);
      return { kind: 'error', text: `查询没成功（${errorText(error)}），但会话本身没有问题。` };
    }
  }

  /** 注册 `/proof`。 */
  function install() {
    const commands = serviceOf(ctx, 'commands');
    if (commands === undefined || typeof commands.register !== 'function') {
      console.log('[perse-proof] 缺少命令注册能力，/proof 不可用（其余功能不受影响）');
      return { ok: false, reason: 'no-commands' };
    }
    try {
      commands.register({
        name: 'proof',
        description: '查看证据台账、判据冻结情况、已登记的结论与告警',
        input: { hint: 'status|facts|criteria|claims|alerts|help' },
        handler,
      });
      console.log('[perse-proof] 已注册 /proof 命令');
      return { ok: true };
    } catch (error) {
      console.log(`[perse-proof] 注册 /proof 命令失败：${errorText(error)}`);
      return { ok: false, reason: errorText(error) };
    }
  }

  return { install, handler };
}
