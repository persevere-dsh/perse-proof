/**
 * perse-proof · C2 声明 ↔ 证据机械对账
 *
 * 规则（docs/SPEC.md §3.3）：
 *   - file 证据：机械核对（存在 + sha256 相符），对不上就拒绝写入，并给出实际摘要；
 *   - command 证据：必须与本会话**真实发生过的工具调用**交叉核对（调用方传进来的
 *     `sessionToolCalls`，或本插件自己记下的工具调用记录）；核对不上就不许标成「已验证」，
 *     除非配置允许（此时自动降级为「部分验证」）；
 *   - 「已验证」而证据全是手写说明（manual）→ 拒绝。
 *
 * 依赖通过参数注入；只 import 无状态的 ./digest.js。除「证据核对失败」外不抛错。
 */

import { fileDigest } from './digest.js';

const LEVELS = ['verified', 'partial', 'unverified'];

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

/** 用了「未失败即成功」这个较弱证据时必须附的说明（与 ledger 侧文本保持一致）。 */
const INFERRED_OK_NOTE =
  '该次执行没有失败标记（本 harness 只在失败时标注退出码），按"未失败即成功"判定，证据强度弱于显式退出码';

function blank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function firstString(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function isShellTool(name) {
  const n = String(name ?? '').toLowerCase();
  return SHELL_TOOLS.has(n) || /(?:^|_)(bash|shell|pwsh|powershell|exec|command|terminal)(?:_|$)/.test(n);
}

/**
 * @param {{store:any, config?:any, logger?:any}} deps
 */
export function createClaims(deps) {
  const { store, config, logger } = deps && typeof deps === 'object' ? deps : {};
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
      warn(`读取记录失败（${error && error.message ? error.message : error}）。`);
      return [];
    }
  }

  function appendRecord(sessionId, type, data) {
    try {
      const result = store.append(sessionId, type, data);
      return !!(result && result.ok !== false);
    } catch (error) {
      warn(`写入记录失败（${error && error.message ? error.message : error}）。`);
      return false;
    }
  }

  /** 收集「真实发生过的命令」池子：调用方传进来的优先，再补上本插件自己记的。 */
  function commandPool(sessionId, sessionToolCalls) {
    const pool = [];
    const push = (entry) => {
      if (!entry || typeof entry !== 'object') return;
      const data = entry.data && typeof entry.data === 'object' ? entry.data : entry;
      const args =
        asObject(data.args) ??
        asObject(data.arguments) ??
        asObject(data.input) ??
        (data.args && typeof data.args === 'object' ? data.args : null);
      const name = data.name ?? entry.name ?? '';
      const command =
        (typeof data.command === 'string' ? data.command : null) ??
        (typeof data.cmd === 'string' ? data.cmd : null) ??
        firstString(args, ['command', 'cmd', 'script', 'shell_command']);
      if (typeof command !== 'string' || command.trim() === '') return;
      const exitCode =
        typeof data.exitCode === 'number'
          ? data.exitCode
          : typeof data.exit_code === 'number'
            ? data.exit_code
            : data.toolResult && typeof data.toolResult.exitCode === 'number'
              ? data.toolResult.exitCode
              : null;
      const outputSha =
        typeof data.outputSha256 === 'string'
          ? data.outputSha256
          : typeof data.output_sha256 === 'string'
            ? data.output_sha256
            : null;
      // 退出码来源：'reported' / 'inferred-ok' / 'unknown'（由 ledger 记工具调用时写下）
      const exitCodeSource =
        typeof data.exitCodeSource === 'string'
          ? data.exitCodeSource
          : typeof data.exit_code_source === 'string'
            ? data.exit_code_source
            : null;
      pool.push({ name, command, exitCode, outputSha, exitCodeSource });
    };

    if (Array.isArray(sessionToolCalls)) for (const entry of sessionToolCalls) push(entry);
    for (const record of readAll(sessionId)) {
      if (record && record.type === 'toolcall') push(record);
    }
    return pool;
  }

  /** 从一条记录里读退出码；读不到就是 null（「没读到」和「读到 0」是两回事）。 */
  function readExitCode(entry) {
    if (!entry || entry.exitCode === undefined || entry.exitCode === null) return null;
    const value = Number(entry.exitCode);
    return Number.isFinite(value) ? value : null;
  }

  /** 从一条记录里读输出摘要；读不到就是 null。 */
  function readOutputSha(entry) {
    if (!entry || typeof entry.outputSha !== 'string') return null;
    const value = entry.outputSha.trim().toLowerCase();
    return value === '' ? null : value;
  }

  /** 从一条记录里读退出码来源；没记就是 null（按「来源不明」处理）。 */
  function readExitCodeSource(entry) {
    const raw = entry ? entry.exitCodeSource : null;
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  }

  /**
   * 在真实命令记录里找一条对得上的。
   *
   * 默认**从严**：只要调用方声明了退出码或输出摘要，就必须在真实记录里真的读得到、并且一致；
   * 「声明了退出码、记录里读不到」不算对上（否则闸门会退化成「命令文本出现过就算验证」）。
   * 只有显式配置 claims.strictCommandEvidence:false，才退回「按命令文本匹配通过」。
   */
  function findCommandMatch(declaredCmd, declared, pool) {
    const wanted = normText(declaredCmd);
    if (wanted === '') return { ok: false, detail: '命令证据没有写命令原文' };
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

    for (const entry of pool) {
      if (!entry) continue;
      const got = normText(entry.command);
      if (got === '') continue;
      if (!(got.includes(wanted) || wanted.includes(got))) continue;
      if (got !== wanted && (wanted.length < 4 || got.length < 4)) continue;

      const entryExit = readExitCode(entry);
      const entrySha = readOutputSha(entry);
      // 来源：'reported'（显式标注）/ 'inferred-ok'（没有失败标记，按未失败即成功推定）/ 'unknown'
      const source = readExitCodeSource(entry);
      const inferredOk = source === 'inferred-ok';

      // 声明了退出码，但记录里读不到 → 默认不通过（继续看其它候选记录）
      if (wantExit !== null && entryExit === null && !inferredOk && strict) {
        sawUnreadableExit = true;
        continue;
      }
      // 推定出来的成功只能支撑「退出码 0」，撑不起任何非 0 声明
      if (wantExit !== null && inferredOk && wantExit !== 0) {
        sawMismatch = true;
        continue;
      }
      // 声明了输出摘要，但记录里没有 → 默认不通过
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
      return { ok: true, detail: `与本会话里真实执行过的命令对上了：${wanted}`, notes };
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
      return { ok: false, detail: `找到了「${wanted}」的执行记录，但退出码或输出摘要与你声明的不一致` };
    }
    return { ok: false, detail: `本会话里没有找到执行过「${wanted}」的记录` };
  }

  return {
    /**
     * 记录一条声明并做机械对账。
     *
     * 返回语义（重要）：
     *   - `ok === true`  → `level` 是**实际判定**的级别（可能因 allowUnmatchedCommands 被降级成 'partial'）；
     *   - `ok === false` → `level` 一律为 `'unverified'`，调用方声明的值放在 `declaredLevel`，
     *     免得只看 `level` 的调用方把「被拒」误读成「已验证」。
     * @returns {{ok:boolean, level:string, declaredLevel:string|null, checked:object[], errors:string[], claim?:string, downgraded?:boolean, notes?:string[]}}
     */
    record(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const claim = typeof input.claim === 'string' ? input.claim.trim() : '';
      const declaredLevel = LEVELS.includes(input.level) ? input.level : null;
      const errors = [];
      if (claim === '') errors.push('必须写明你要声明什么。');
      if (declaredLevel === null) {
        errors.push('可信度只能填「已验证 / 部分验证 / 未验证」三者之一。');
      }

      let evidence = input.evidence;
      if (typeof evidence === 'string') {
        try {
          evidence = JSON.parse(evidence);
        } catch {
          errors.push('证据格式看不懂（应该是一个列表）。');
          evidence = [];
        }
      }
      if (evidence === undefined || evidence === null) evidence = [];
      if (!Array.isArray(evidence)) {
        errors.push('证据应该是一个列表。');
        evidence = [];
      }
      if (errors.length > 0) {
        // 被拒时 level 一律是「未验证」：声明值只放在 declaredLevel 里，
        // 免得只看 level 的调用方把「被拒」误读成「已验证」。
        return { ok: false, level: 'unverified', declaredLevel, checked: [], errors };
      }

      const pool = commandPool(input.sessionId, input.sessionToolCalls);
      const checked = [];
      const cleaned = [];
      const notes = [];
      const fatal = [];
      const unmatchedCommands = [];
      let manualOnly = true;

      for (const raw of evidence) {
        const item =
          typeof raw === 'string'
            ? { kind: 'manual', note: raw }
            : raw && typeof raw === 'object' && !Array.isArray(raw)
              ? { ...raw }
              : null;
        if (!item) {
          fatal.push('有一条证据看不懂（既不是文字说明也不是结构化记录）。');
          continue;
        }
        const kind = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '';
        if (kind === 'file') {
          const filePath = typeof item.path === 'string' ? item.path.trim() : '';
          if (filePath === '') {
            fatal.push('有一条文件证据没有写文件路径。');
            continue;
          }
          const digest = fileDigest(filePath);
          if (!digest.ok) {
            fatal.push(`文件证据核对不上：${digest.error}。`);
            continue;
          }
          const declaredSha = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
          if (declaredSha !== '' && declaredSha !== digest.sha256) {
            fatal.push(`文件证据对不上：${filePath} 现在的摘要是 ${digest.sha256}，但你声明的是 ${declaredSha}。`);
            continue;
          }
          manualOnly = false;
          cleaned.push({ kind: 'file', path: filePath, sha256: digest.sha256 });
          checked.push({
            kind: 'file',
            ok: true,
            detail:
              declaredSha === ''
                ? `文件存在：${filePath}（没有给摘要，只核对了存在性）`
                : `文件存在且摘要一致：${filePath}`,
          });
          continue;
        }
        if (kind === 'command') {
          const cmd = typeof item.cmd === 'string' ? item.cmd : typeof item.command === 'string' ? item.command : '';
          if (cmd.trim() === '') {
            fatal.push('有一条命令证据没有写命令原文。');
            continue;
          }
          manualOnly = false;
          const match = findCommandMatch(cmd, item, pool);
          if (match.ok) {
            cleaned.push({ kind: 'command', cmd: cmd.trim(), exitCode: item.exitCode ?? null, outputSha256: item.outputSha256 ?? null });
            checked.push({ kind: 'command', ok: true, detail: match.detail });
            if (Array.isArray(match.notes)) notes.push(...match.notes);
          } else {
            cleaned.push({ kind: 'command', cmd: cmd.trim(), exitCode: item.exitCode ?? null, outputSha256: item.outputSha256 ?? null });
            checked.push({ kind: 'command', ok: false, detail: match.detail });
            unmatchedCommands.push(match.detail);
          }
          continue;
        }
        if (kind === 'manual' || kind === '') {
          const note = typeof item.note === 'string' ? item.note : typeof item.text === 'string' ? item.text : '';
          if (note.trim() === '') {
            fatal.push('有一条手写证据是空的。');
            continue;
          }
          cleaned.push({ kind: 'manual', note: note.trim() });
          checked.push({ kind: 'manual', ok: true, detail: '手写说明（不能单独支撑「已验证」）' });
          continue;
        }
        fatal.push(`有一条证据的类型看不懂（${kind}）：只认「文件」「命令」「手写说明」三种。`);
      }

      if (fatal.length > 0) {
        return { ok: false, level: 'unverified', declaredLevel, checked, errors: fatal };
      }

      let finalLevel = declaredLevel;
      let downgraded = false;

      if (declaredLevel === 'verified') {
        if (evidence.length === 0) {
          errors.push('想标成「已验证」就必须给出至少一条证据，现在一条都没有。');
        } else if (manualOnly) {
          errors.push('只有手写说明不能算「已验证」，最多只能标成「部分验证」。请补上文件或命令证据。');
        }
        if (unmatchedCommands.length > 0) {
          const allowed =
            claimsConfig().allowUnmatchedCommands === true || claimsConfig().strictCommandEvidence === false;
          if (allowed) {
            finalLevel = 'partial';
            downgraded = true;
            notes.push('命令没有和真实执行记录对上，已自动降级为「部分验证」。');
          } else {
            errors.push(
              `命令证据核对不上：${unmatchedCommands.join('；')}。要么补上真实的执行记录，要么把可信度降成「部分验证」。`,
            );
          }
        }
        if (errors.length > 0) {
          return { ok: false, level: 'unverified', declaredLevel, checked, errors };
        }
      }

      const data = {
        claim,
        level: finalLevel,
        declaredLevel,
        scope: blank(input.scope) ? null : String(input.scope).trim(),
        evidence: cleaned,
        checked,
        downgraded,
        notes,
        at: Date.now(),
      };
      const ok = appendRecord(input.sessionId, 'claim', data);
      if (!ok) {
        return {
          ok: false,
          level: 'unverified',
          declaredLevel,
          checked,
          errors: ['这条声明没能存下来（写文件失败），请稍后重试。'],
        };
      }
      return { ok: true, level: finalLevel, declaredLevel, checked, errors: [], claim, downgraded, notes };
    },

    /**
     * 列出本会话的全部声明。
     * @returns {object[]}
     */
    list(sessionId) {
      const out = [];
      for (const record of readAll(sessionId)) {
        if (!record || record.type !== 'claim' || !record.data) continue;
        const data = record.data;
        out.push({
          claim: data.claim,
          level: data.level,
          declaredLevel: data.declaredLevel ?? data.level,
          scope: data.scope ?? null,
          evidence: Array.isArray(data.evidence) ? data.evidence : [],
          checked: Array.isArray(data.checked) ? data.checked : [],
          downgraded: data.downgraded === true,
          at: data.at ?? record.ts ?? null,
          seq: record.seq,
        });
      }
      return out;
    },

    /**
     * 本会话里有没有出现过「已验证」的声明。
     * @param {string} sessionId
     * @param {number} [sinceTs] 只看这个时间点之后的
     * @returns {boolean}
     */
    hasVerified(sessionId, sinceTs) {
      const since = typeof sinceTs === 'number' && Number.isFinite(sinceTs) ? sinceTs : null;
      for (const record of readAll(sessionId)) {
        if (!record || record.type !== 'claim' || !record.data) continue;
        if (record.data.level !== 'verified') continue;
        const at = typeof record.data.at === 'number' ? record.data.at : record.ts;
        if (since !== null && typeof at === 'number' && at < since) continue;
        return true;
      }
      return false;
    },
  };
}
