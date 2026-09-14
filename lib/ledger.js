/**
 * perse-proof · C3 台账
 *
 * 三件事：
 *   1. 事实台账（setFact）：写进来的每一条 file 证据都做存在性 + sha256 核对，对不上就不写；
 *      command 证据要与本会话真实发生过的工具调用交叉核对（核对不过默认拒收）。
 *   2. 待办丢项（noteTodoList / noteToolCall）：上一版里还没做完、这一版却消失的条目，
 *      产出 1 条 todo-drop 告警，并给出可以直接注入给模型的提示文本。
 *   3. 写放大（noteToolCall）：同一个文件反复重写超过阈值 → 每个文件每会话只报一次 write-amplify。
 *
 * 依赖通过参数注入；只 import 无状态的 ./digest.js。绝不抛错到调用方。
 */

import { fileDigest, textDigest } from './digest.js';

const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'writefile',
  'create_file',
  'createfile',
  'edit',
  'edit_file',
  'editfile',
  'multi_edit',
  'multiedit',
  'apply_patch',
  'patch',
  'str_replace',
  'str_replace_editor',
  'replace_in_file',
  'insert_content',
  'notebook_edit',
  'save_file',
  'fs_write',
]);

const READ_TOOLS = new Set([
  'read',
  'read_file',
  'readfile',
  'read_many_files',
  'cat',
  'view',
  'list_dir',
  'listdir',
  'ls',
  'glob',
  'grep',
  'search',
  'search_files',
  'fs_read',
]);

const SHELL_TOOLS = new Set([
  'bash',
  'pwsh',
  'powershell',
  'shell',
  'sh',
  'zsh',
  'cmd',
  'command',
  'exec',
  'execute',
  'run',
  'run_command',
  'runcommand',
  'unified_exec',
  'terminal',
  'process',
]);

/** 用了「未失败即成功」这个较弱证据时必须附的说明（claim / fact 核对共用，两边文本必须一致）。 */
const INFERRED_OK_NOTE =
  '该次执行没有失败标记（本 harness 只在失败时标注退出码），按"未失败即成功"判定，证据强度弱于显式退出码';

function blank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim();
}

function samePath(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (x === '' || y === '') return false;
  return x === y;
}

function firstString(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** 从工具参数里解析对象（参数可能是 JSON 字符串）。 */
function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/** 把工具结果里的文本拼出来（有上限，避免啃大输出）。 */
function contentText(toolResult) {
  if (toolResult === undefined || toolResult === null) return '';
  if (typeof toolResult === 'string') return toolResult.slice(0, 20000);
  const parts = [];
  const blocks = Array.isArray(toolResult.content) ? toolResult.content : [];
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    if (parts.join('\n').length > 20000) break;
  }
  if (parts.length === 0 && typeof toolResult.text === 'string') parts.push(toolResult.text);
  return parts.join('\n').slice(0, 20000);
}

/** 结果里有没有**显式**退出码（数值字段，或文本标记如 `[exit code: 1]`）。读不到返回 null。 */
function reportedExitCode(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return null;
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    const value = toolResult[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const error = toolResult.error;
  if (error && typeof error === 'object') {
    for (const key of ['exitCode', 'exit_code']) {
      if (typeof error[key] === 'number' && Number.isFinite(error[key])) return error[key];
    }
  }
  const text = contentText(toolResult);
  const match = /\[?\s*(?:exit code|exit status|退出码|返回码)\s*[:：=]?\s*(-?\d{1,4})\s*\]?/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * 推导这次调用的退出码与**来源**（来源要如实记下来，否则核对时无法区分"读到 0"和"推定成功"）：
 *   'reported'    结果里有显式退出码（数值字段或 `[exit code: N]` 标记）
 *   'inferred-ok' 没有标记，但结果明确 `isError === false`（本 harness 只在失败时标注退出码，
 *                 没有失败标记即视为成功；证据强度弱于显式退出码）
 *   'unknown'     没有标记，且结果不是明确的成功（`isError === true` 或压根没给）
 */
function resolveExitCode(toolResult) {
  const reported = reportedExitCode(toolResult);
  if (reported !== null) return { exitCode: reported, exitCodeSource: 'reported' };
  if (toolResult && typeof toolResult === 'object' && toolResult.isError === false) {
    return { exitCode: 0, exitCodeSource: 'inferred-ok' };
  }
  return { exitCode: null, exitCodeSource: 'unknown' };
}

function extractOutputSha(toolResult) {
  if (toolResult && typeof toolResult === 'object') {
    const declared = toolResult.outputSha256 ?? toolResult.output_sha256;
    if (typeof declared === 'string' && declared.trim() !== '') return declared.trim().toLowerCase();
  }
  const text = contentText(toolResult);
  if (text === '') return null;
  try {
    return textDigest(text);
  } catch {
    return null;
  }
}

function itemContent(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    for (const key of ['content', 'text', 'subject', 'title']) {
      if (typeof item[key] === 'string') return item[key];
    }
  }
  return item === undefined || item === null ? '' : String(item);
}

function normContent(value) {
  return String(value ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')
    .replace(/^\s*\[[ xX✓-]?\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normStatus(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'in_progress' || raw === 'inprogress' || raw === 'doing' || raw === 'active' || raw === '进行中')
    return 'in_progress';
  if (raw === 'pending' || raw === 'todo' || raw === 'open' || raw === '待办' || raw === '未开始')
    return 'pending';
  if (raw === 'completed' || raw === 'complete' || raw === 'done' || raw === '已完成' || raw === '完成')
    return 'completed';
  if (raw === 'cancelled' || raw === 'canceled' || raw === '已取消') return 'cancelled';
  return raw === '' ? 'pending' : raw;
}

function isOpenStatus(status) {
  const s = normStatus(status);
  return s === 'pending' || s === 'in_progress';
}

/**
 * @param {{store:any, config?:any, logger?:any}} deps
 */
export function createLedger(deps) {
  const { store, config, logger } = deps && typeof deps === 'object' ? deps : {};
  const ledgerConfig = () => (config && config.ledger) || {};
  const claimsConfig = () => (config && config.claims) || {};

  function warn(message) {
    const text = `[perse-proof] ${message}`;
    try {
      console.log(text);
    } catch {
      /* 忽略 */
    }
    if (logger && typeof logger.info === 'function') {
      try {
        logger.info(text);
      } catch {
        /* 忽略 */
      }
    }
  }

  function readAll(sessionId) {
    try {
      const records = store.read(sessionId);
      return Array.isArray(records) ? records : [];
    } catch (error) {
      warn(`读取台账失败（${error && error.message ? error.message : error}）。`);
      return [];
    }
  }

  function appendRecord(sessionId, type, data) {
    try {
      const result = store.append(sessionId, type, data);
      return !!(result && result.ok !== false);
    } catch (error) {
      warn(`写入台账失败（${error && error.message ? error.message : error}）。`);
      return false;
    }
  }

  function toolCalls(records) {
    return records.filter((r) => r && r.type === 'toolcall' && r.data && typeof r.data === 'object');
  }

  function isShellTool(name) {
    const n = String(name ?? '').toLowerCase();
    return SHELL_TOOLS.has(n) || /(?:^|_)(bash|shell|pwsh|powershell|exec|command|terminal)(?:_|$)/.test(n);
  }

  /** 从一条候选记录里读退出码；读不到就是 null（「没读到」和「读到 0」是两回事）。 */
  function readExitCode(candidate) {
    const raw = candidate ? candidate.exitCode : null;
    if (raw === undefined || raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** 从一条候选记录里读输出摘要；读不到就是 null。 */
  function readOutputSha(candidate) {
    const raw = candidate ? candidate.outputSha : null;
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    return value === '' ? null : value;
  }

  /** 从一条候选记录里读退出码来源；没记就是 null（按「来源不明」处理）。 */
  function readExitCodeSource(candidate) {
    const raw = candidate ? candidate.exitCodeSource : null;
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  }

  /**
   * 在真实工具调用记录里找一条命令匹配（供本模块 setFact 与 claims 交叉核对复用）。
   *
   * 默认**从严**（与 claims 同规则）：只要声明了退出码或输出摘要，就必须在真实记录里真的
   * 读得到、并且一致；「声明了、但记录里读不到」不算对上。只有显式配置
   * claims.strictCommandEvidence:false，才退回「按命令文本匹配通过」。
   */
  function findCommandMatch(declaredCmd, declared, records) {
    const wanted = normContent(declaredCmd);
    if (wanted === '') return { ok: false, detail: '命令证据没写命令原文' };
    const candidates = [];
    for (const record of records) {
      const data = record.type === 'toolcall' ? record.data : record;
      if (!data || typeof data !== 'object') continue;
      const name = data.name;
      if (!isShellTool(name) && !(record.type === 'toolcall' && typeof data.command === 'string' && data.command))
        continue;
      const args = asObject(data.args) ?? asObject(data.arguments) ?? asObject(data.input);
      const cmd =
        (typeof data.command === 'string' ? data.command : null) ??
        firstString(args, ['command', 'cmd', 'script', 'shell_command']) ??
        (typeof data.cmd === 'string' ? data.cmd : null);
      if (typeof cmd !== 'string' || cmd.trim() === '') continue;
      const got = normContent(cmd);
      if (!(got.includes(wanted) || wanted.includes(got))) continue;
      if ((wanted.length < 4 || got.length < 4) && got !== wanted) continue;
      const exitCode = data.exitCode ?? data.exit_code ?? null;
      const outputSha = data.outputSha256 ?? data.output_sha256 ?? null;
      const exitCodeSource = data.exitCodeSource ?? data.exit_code_source ?? null;
      candidates.push({ record, exitCode, outputSha, exitCodeSource });
    }
    if (candidates.length === 0) {
      return { ok: false, detail: `本会话里找不到「${declaredCmd}」这条真实执行记录` };
    }
    const wantExit =
      declared && declared.exitCode !== undefined && declared.exitCode !== null ? Number(declared.exitCode) : null;
    const wantSha =
      declared && typeof declared.outputSha256 === 'string' && declared.outputSha256.trim() !== ''
        ? declared.outputSha256.trim().toLowerCase()
        : null;
    const strict = claimsConfig().strictCommandEvidence !== false;

    let sawUnreadableExit = false;
    let sawUnreadableSha = false;
    let sawMismatch = false;

    for (const candidate of candidates) {
      const entryExit = readExitCode(candidate);
      const entrySha = readOutputSha(candidate);
      // 来源：'reported'（显式标注）/ 'inferred-ok'（没有失败标记，按未失败即成功推定）/ 'unknown'
      const source = readExitCodeSource(candidate);
      const inferredOk = source === 'inferred-ok';

      if (wantExit !== null && entryExit === null && !inferredOk && strict) {
        sawUnreadableExit = true;
        continue;
      }
      if (wantExit !== null && inferredOk && wantExit !== 0) {
        // 推定的成功只能支撑「退出码 0」，撑不起任何非 0 声明
        sawMismatch = true;
        continue;
      }
      if (wantSha !== null && entrySha === null && strict) {
        sawUnreadableSha = true;
        continue;
      }

      const exitOk = wantExit === null || entryExit === null || entryExit === wantExit;
      const shaOk = wantSha === null || entrySha === null || entrySha === wantSha;
      if (!exitOk || !shaOk) {
        sawMismatch = true;
        continue;
      }

      const notes = [];
      if (wantExit !== null && inferredOk) notes.push(INFERRED_OK_NOTE);
      if (!strict) {
        if (wantExit !== null && entryExit === null) notes.push('记录里读不到退出码，按命令文本匹配通过');
        if (wantSha !== null && entrySha === null) notes.push('记录里没有输出摘要，按命令文本匹配通过');
      }
      return { ok: true, detail: `与本会话的真实执行记录对上了：${declaredCmd}`, notes };
    }

    if (sawUnreadableExit) {
      return {
        ok: false,
        detail:
          '找到了执行记录，但记录里读不到退出码，无法核对 —— 若要按命令文本匹配通过，请在配置里显式放宽（claims.strictCommandEvidence: false）',
      };
    }
    if (sawUnreadableSha) {
      return {
        ok: false,
        detail:
          '找到了执行记录，但记录里没有输出摘要，无法核对 —— 若要按命令文本匹配通过，请在配置里显式放宽（claims.strictCommandEvidence: false）',
      };
    }
    if (sawMismatch) {
      return { ok: false, detail: `找到了「${declaredCmd}」的执行记录，但退出码或输出摘要与声明的不一致` };
    }
    return { ok: false, detail: `本会话里找不到「${declaredCmd}」这条真实执行记录` };
  }

  function validateEvidence(sessionId, rawEvidence, records) {
    const checked = [];
    const errors = [];
    let downgraded = false;
    let evidence = rawEvidence;
    if (typeof evidence === 'string') {
      try {
        evidence = JSON.parse(evidence);
      } catch {
        return { evidence: [], checked, errors: ['证据格式看不懂（应该是一个列表）。'], downgraded };
      }
    }
    if (evidence === undefined || evidence === null) evidence = [];
    if (!Array.isArray(evidence)) {
      return { evidence: [], checked, errors: ['证据应该是一个列表。'], downgraded };
    }
    const cleaned = [];
    for (const raw of evidence) {
      const item =
        typeof raw === 'string'
          ? { kind: 'manual', note: raw }
          : raw && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...raw }
            : null;
      if (!item) {
        errors.push('有一条证据看不懂（既不是文字说明也不是结构化记录）。');
        continue;
      }
      const kind = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '';
      if (kind === 'file') {
        const filePath = typeof item.path === 'string' ? item.path.trim() : '';
        if (filePath === '') {
          errors.push('有一条文件证据没有写文件路径。');
          continue;
        }
        const digest = fileDigest(filePath);
        if (!digest.ok) {
          errors.push(`文件证据核对不上：${digest.error}。`);
          continue;
        }
        const declared = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
        if (declared !== '' && declared !== digest.sha256) {
          errors.push(`文件证据对不上：${filePath} 现在的摘要是 ${digest.sha256}，但记录里写的是 ${declared}。`);
          continue;
        }
        cleaned.push({ kind: 'file', path: filePath, sha256: digest.sha256 });
        checked.push({
          kind: 'file',
          ok: true,
          detail: declared === '' ? `文件存在：${filePath}（没有给摘要，只核对了存在性）` : `文件存在且摘要一致：${filePath}`,
        });
        continue;
      }
      if (kind === 'command') {
        const cmd = typeof item.cmd === 'string' ? item.cmd : typeof item.command === 'string' ? item.command : '';
        if (cmd.trim() === '') {
          errors.push('有一条命令证据没有写命令原文。');
          continue;
        }
        const match = findCommandMatch(cmd, item, records);
        if (!match.ok) {
          if (claimsConfig().strictCommandEvidence !== false) {
            errors.push(`命令证据核对不上：${match.detail}。要么补上真实的执行记录，要么把这条降级成手写说明。`);
            continue;
          }
          downgraded = true;
          cleaned.push({ kind: 'command', cmd: cmd.trim(), exitCode: item.exitCode ?? null, outputSha256: item.outputSha256 ?? null });
          checked.push({ kind: 'command', ok: false, detail: `${match.detail}（已按配置放宽，降级保留）` });
          continue;
        }
        cleaned.push({ kind: 'command', cmd: cmd.trim(), exitCode: item.exitCode ?? null, outputSha256: item.outputSha256 ?? null });
        checked.push({ kind: 'command', ok: true, detail: match.detail });
        continue;
      }
      if (kind === 'manual' || kind === '') {
        const note = typeof item.note === 'string' ? item.note : typeof item.text === 'string' ? item.text : '';
        if (note.trim() === '') {
          errors.push('有一条手写证据是空的。');
          continue;
        }
        cleaned.push({ kind: 'manual', note: note.trim() });
        checked.push({ kind: 'manual', ok: true, detail: '手写说明（不能单独支撑「已验证」）' });
        continue;
      }
      errors.push(`有一条证据的类型看不懂（${kind}）：只认「文件」「命令」「手写说明」三种。`);
    }
    return { evidence: cleaned, checked, errors, downgraded };
  }

  function lastFact(records, key) {
    let found = null;
    for (const record of records) {
      if (record && record.type === 'fact' && record.data && record.data.key === key) found = record;
    }
    return found;
  }

  function lastTodos(records) {
    let found = null;
    for (const record of records) {
      if (record && record.type === 'toolcall' && record.data && Array.isArray(record.data.todos)) found = record;
    }
    return found;
  }

  function detectTodoDrop(previous, nextTodos, nextSeq) {
    if (!previous || !Array.isArray(previous.data && previous.data.todos)) return null;
    const previousOpen = previous.data.todos.filter((item) => isOpenStatus(item && item.status));
    if (previousOpen.length === 0) return null;
    const nowKeys = new Set(nextTodos.map((item) => normContent(itemContent(item))));
    const dropped = previousOpen.filter((item) => !nowKeys.has(normContent(itemContent(item))));
    if (dropped.length === 0) return null;
    const names = dropped.map((item) => itemContent(item).trim()).filter((n) => n !== '');
    const shown = names.slice(0, 8).map((n) => `「${n}」`).join('、');
    const more = names.length > 8 ? ` 等 ${names.length} 项` : '';
    return {
      kind: 'todo-drop',
      count: dropped.length,
      items: names,
      message: `上一轮清单里有 ${dropped.length} 项没标完成就消失了：${shown}${more}。如果是有意删除，请显式说明；否则请把它们标成已完成。`,
      refs: [previous.seq, nextSeq].filter((n) => typeof n === 'number' && n >= 0),
      at: Date.now(),
    };
  }

  function recordToolCall(sessionId, data) {
    return appendRecord(sessionId, 'toolcall', data);
  }

  function countWrites(records, filePath) {
    return records.filter(
      (r) => r && r.type === 'toolcall' && r.data && r.data.isWrite === true && samePath(r.data.path, filePath),
    ).length;
  }

  function alreadyAlerted(records, kind, filePath) {
    return records.some(
      (r) =>
        r &&
        r.type === 'alert' &&
        r.data &&
        r.data.kind === kind &&
        (filePath === undefined || samePath(r.data.path, filePath)),
    );
  }

  function alertView(record) {
    const data = record.data || {};
    return {
      kind: data.kind ?? 'unknown',
      detail: data.detail ?? data.message ?? '',
      message: data.message ?? data.detail ?? '',
      path: data.path ?? null,
      count: data.count ?? null,
      items: Array.isArray(data.items) ? data.items : undefined,
      refs: Array.isArray(data.refs) ? data.refs : [],
      at: data.at ?? record.ts ?? null,
      seq: record.seq,
    };
  }

  return {
    /**
     * 写一条事实（含证据机械核对）。
     * @returns {{ok:boolean, errors:string[], checked?:object[], key?:string, downgraded?:boolean}}
     */
    setFact(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const errors = [];
      const key = typeof input.key === 'string' ? input.key.trim() : '';
      if (key === '') errors.push('必须给出这条事实的名字。');
      let value = input.value;
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        errors.push('必须给出这条事实的内容。');
      } else if (typeof value !== 'string') {
        value = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      if (errors.length > 0) return { ok: false, errors, checked: [] };

      const records = readAll(input.sessionId);
      const validated = validateEvidence(input.sessionId, input.evidence, records);
      if (validated.errors.length > 0) {
        return { ok: false, errors: validated.errors, checked: validated.checked };
      }

      const previous = lastFact(records, key);
      const data = {
        key,
        value,
        evidence: validated.evidence,
        note: typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null,
        source: input.source === 'model' ? 'model' : 'tool',
        supersedes: previous ? previous.seq : null,
        checked: validated.checked,
        at: Date.now(),
      };
      const ok = appendRecord(input.sessionId, 'fact', data);
      if (!ok) return { ok: false, errors: ['这条事实没能存下来（写文件失败），请稍后重试。'], checked: validated.checked };
      return { ok: true, errors: [], checked: validated.checked, key, downgraded: validated.downgraded === true };
    },

    /**
     * 读回事实台账（同名的取最新一条）。
     * @returns {Record<string,{value:string, at:number, source:string, evidence:object[], note:string|null}>}
     */
    facts(sessionId) {
      const out = {};
      for (const record of readAll(sessionId)) {
        if (!record || record.type !== 'fact' || !record.data) continue;
        const data = record.data;
        if (typeof data.key !== 'string' || data.key === '') continue;
        out[data.key] = {
          value: data.value,
          at: data.at ?? record.ts ?? null,
          source: data.source ?? 'tool',
          evidence: Array.isArray(data.evidence) ? data.evidence : [],
          note: data.note ?? null,
        };
      }
      return out;
    },

    /**
     * 记一次工具调用：待办丢项 + 写放大。
     * @returns {{alerts:object[], inject:string|null}}
     */
    noteToolCall(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const sessionId = input.sessionId;
      const name = typeof input.name === 'string' ? input.name : '';
      const lower = name.toLowerCase();
      const args =
        asObject(input.args) ??
        asObject(input.arguments) ??
        asObject(input.input) ??
        (input.args && typeof input.args === 'object' ? input.args : null);
      const toolResult = input.toolResult;
      const filePath =
        firstString(args, ['file_path', 'filePath', 'path', 'filename', 'file', 'target_file', 'notebook_path']) ??
        firstString(input, ['path']);
      const isWrite = WRITE_TOOLS.has(lower) || /(?:^|_)(write|edit|patch|replace)(?:_|$)/.test(lower);
      const isRead = !isWrite && (READ_TOOLS.has(lower) || /(?:^|_)(read|list|glob|grep|search|cat|view)(?:_|$)/.test(lower));
      const command = firstString(args, ['command', 'cmd', 'script', 'shell_command']);
      // 退出码要连**来源**一起记：显式标注 / 未失败即成功（推定）/ 读不到。
      // 不记来源的话，核对时就没法区分「读到 0」和「推定成功」，收紧就变成了不可用。
      const { exitCode, exitCodeSource } = resolveExitCode(toolResult);
      const outputSha256 = extractOutputSha(toolResult);
      const todos = Array.isArray(args && args.todos)
        ? args.todos
        : Array.isArray(args && args.items) && /todo/.test(lower)
          ? args.items
          : null;

      const records = readAll(sessionId);
      const alerts = [];
      let inject = null;

      let todoAlert = null;
      if (todos && ledgerConfig().todoDropDetect !== false) {
        todoAlert = detectTodoDrop(lastTodos(records), todos, records.length);
      }

      const writeSeq = records.length;
      recordToolCall(sessionId, {
        name,
        path: filePath,
        command,
        exitCode,
        exitCodeSource,
        outputSha256,
        isWrite,
        isRead,
        ok: !(toolResult && toolResult.isError === true),
        todos: todos ?? undefined,
        at: Date.now(),
      });

      if (todoAlert) {
        alerts.push(todoAlert);
        inject = todoAlert.message;
        appendRecord(sessionId, 'alert', todoAlert);
      }

      const threshold = Number(ledgerConfig().writeAmplifyThreshold);
      const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : 8;
      if (isWrite && filePath && ledgerConfig().enabled !== false && !alreadyAlerted(records, 'write-amplify', filePath)) {
        const count = countWrites(records, filePath) + 1;
        if (count >= limit) {
          const data = {
            kind: 'write-amplify',
            path: filePath,
            count,
            detail: `同一个文件已经被改写了 ${count} 次`,
            message: `同一个文件已经改了 ${count} 次（${filePath}）：反复重写同一个文件通常说明没想清楚要什么。建议先看清现状、一次改到位，或者停下来说明为什么要反复改。`,
            refs: [writeSeq],
            at: Date.now(),
          };
          alerts.push(data);
          appendRecord(sessionId, 'alert', data);
        }
      }

      return { alerts, inject };
    },

    /**
     * 记一版待办清单，检测「上一版没完成就消失」的条目。
     * @returns {{alerts:object[], inject:string|null}}
     */
    noteTodoList(sessionId, todos) {
      const list = Array.isArray(todos) ? todos : [];
      const records = readAll(sessionId);
      const alerts = [];
      let inject = null;
      const todoAlert =
        ledgerConfig().todoDropDetect === false ? null : detectTodoDrop(lastTodos(records), list, records.length);
      recordToolCall(sessionId, {
        name: 'todo_write',
        isWrite: false,
        isRead: false,
        todos: list,
        at: Date.now(),
      });
      if (todoAlert) {
        alerts.push(todoAlert);
        inject = todoAlert.message;
        appendRecord(sessionId, 'alert', todoAlert);
      }
      return { alerts, inject };
    },

    /**
     * 台账统计（读/写次数、被改最多的文件、告警）。
     * @returns {{reads:number, writes:number, topRewritten:Array<{path:string,count:number}>, alerts:object[]}}
     */
    stats(sessionId) {
      const records = readAll(sessionId);
      let reads = 0;
      let writes = 0;
      const byPath = new Map();
      for (const record of records) {
        if (!record || record.type !== 'toolcall' || !record.data) continue;
        if (record.data.isRead === true) reads += 1;
        if (record.data.isWrite === true) {
          writes += 1;
          const path = record.data.path;
          if (typeof path === 'string' && path !== '') byPath.set(path, (byPath.get(path) ?? 0) + 1);
        }
      }
      const topRewritten = [...byPath.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
        .slice(0, 5);
      const alerts = records.filter((r) => r && r.type === 'alert').map(alertView);
      return { reads, writes, topRewritten, alerts };
    },

    /** 内部复用：供 claims 做命令交叉核对（同一套匹配规则）。 */
    __findCommandMatch(declaredCmd, declared, sessionId) {
      return findCommandMatch(declaredCmd, declared, readAll(sessionId));
    },
  };
}
