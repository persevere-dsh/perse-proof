/**
 * perse-proof · lib/gates.js
 *
 * 完成声明闸门 + 代号闸门（SPEC §3.5）。两条都是「观测 + 注入一次要求」，
 * 不阻断、不改写会话、不自行修改任何状态。
 * 配额：两条闸门共享 `report.maxGatesPerTurn`（默认 1），按 turnKey 记账。
 */

import { truncate, errorText, intOr } from './util.js';

/** 完成性措辞（SPEC §3.5，写死）。 */
const COMPLETION_PATTERN = /已完成|已经完成|全部通过|通过了|验证通过|已验证|搞定|收口完成|PASS\b/;

/** 未释义代号的默认模式：SPEC §3.5 的三条 + 一条宽松模式（覆盖裸代号如 D8 / N3 / O1）。 */
const CODENAME_PATTERNS = [
  /\b[A-Z]{1,5}-\d+[a-z]?\b/g,
  /\bS\d[a-i]\b/g,
  /\bWP\d+\b/g,
  /\b[A-Z]{1,2}\d{1,3}\b/g,
];

/** 宽松模式的默认忽略名单：版本号、标准名、通用缩写不算内部代号；可被 `config.jargon.ignore` 追加覆盖。 */
const DEFAULT_IGNORE = ['S3', 'H2', 'B2', 'A4', 'UTF8', 'HTTP2', 'SHA256', 'MD5', 'GPT4', 'GPT5', 'ISO8601'];

/** 完成声明闸门的注入要求（中文白话、可执行、≤200 字）。 */
const CLAIM_MESSAGE = [
  '你这条回复里写了「已完成 / 已验证 / 全部通过」，但本会话还没有登记过任何已核验的结论。',
  '请二选一：(1) 用 proof_claim 登记结论，并附上真实存在的文件（含 sha256）或真实执行过的命令（含退出码）；',
  '(2) 把「已完成 / 验证通过」改写成「未验证 / 待验证」，并说明还差哪一步。改完再结束本轮。',
].join('');

/** 代号闸门的注入要求（中文白话、可执行、≤200 字）。 */
function jargonMessage(samples) {
  const list = samples.slice(0, 5).join('、');
  return truncate(
    `你这条面向用户的回复里有多个没解释的代号（如 ${list || 'D8、WP8'}）。`
    + '请改写成白话：确需引用时第一次出现写成「白话名称（代号）」，例如「主按钮（D8）」；'
    + '不需要保留代号就整句改成白话。改完再结束本轮。',
    200,
  );
}

/**
 * @param {{config?:object, logger?:object, store?:object, claims?:object}} deps
 */
export function createGates({ config, store, claims } = {}) {
  const jargonEnabled = config?.jargon?.enabled !== false;
  const extraPatterns = Array.isArray(config?.jargon?.extraPatterns) ? config.jargon.extraPatterns : [];
  const minCodenameCount = intOr(config?.jargon?.minCodenameCount, 2);
  const claimGateEnabled = config?.claims?.enabled !== false && config?.claims?.gateOnCompletionClaim !== false;
  const maxGatesPerTurn = Math.max(0, intOr(config?.report?.maxGatesPerTurn, 1));
  const ignore = new Set(
    [...DEFAULT_IGNORE, ...(Array.isArray(config?.jargon?.ignore) ? config.jargon.ignore : [])]
      .filter((item) => typeof item === 'string' && item !== '')
      .map((item) => item.toUpperCase()),
  );

  /** turnKey → 本轮已干预次数（共享配额） */
  const quotaByTurn = new Map();
  /** turnKey → 本轮已触发的闸门种类（同一 kind 每轮最多一次） */
  const kindsByTurn = new Map();

  function patterns() {
    const compiled = [...CODENAME_PATTERNS];
    for (const extra of extraPatterns) {
      if (extra instanceof RegExp) {
        compiled.push(new RegExp(extra.source, extra.flags.includes('g') ? extra.flags : `${extra.flags}g`));
        continue;
      }
      if (typeof extra === 'string' && extra !== '') {
        try {
          compiled.push(new RegExp(extra, 'g'));
        } catch (error) {
          console.log(`[perse-proof] 代号模式无法编译，已忽略：${errorText(error)}`);
        }
      }
    }
    return compiled;
  }

  /** 扫描完成性措辞。 */
  function scanCompletion(text) {
    const body = typeof text === 'string' ? text : '';
    if (body === '') return { hit: false, phrases: [] };
    const global = new RegExp(COMPLETION_PATTERN.source, 'g');
    const phrases = [];
    let match;
    while ((match = global.exec(body)) !== null) {
      phrases.push(match[0]);
      if (global.lastIndex <= match.index) global.lastIndex = match.index + 1;
    }
    return { hit: phrases.length > 0, phrases: [...new Set(phrases)] };
  }

  /** 某个代号是否被解释：该代号紧跟「（白话）」或「(白话)」。 */
  function isExplained(body, index, token) {
    const after = body.slice(index + token.length, index + token.length + 40);
    return /^\s*[（(][^）)]{1,40}[）)]/.test(after);
  }

  /** 扫描未释义代号（忽略名单里的不算代号）。 */
  function scanCodenames(text) {
    const body = typeof text === 'string' ? text : '';
    if (body === '') return { count: 0, samples: [], matches: [], explained: 0 };
    const found = [];
    const seenIndex = new Set();
    for (const pattern of patterns()) {
      const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let match;
      while ((match = regex.exec(body)) !== null) {
        if (regex.lastIndex <= match.index) regex.lastIndex = match.index + 1;
        if (seenIndex.has(match.index)) continue;
        seenIndex.add(match.index);
        if (ignore.has(match[0].toUpperCase())) continue;
        found.push({ text: match[0], index: match.index, explained: isExplained(body, match.index, match[0]) });
      }
    }
    found.sort((a, b) => a.index - b.index);
    const unexplained = found.filter((item) => !item.explained);
    return {
      count: unexplained.length,
      samples: [...new Set(unexplained.map((item) => item.text))].slice(0, 5),
      matches: found,
      explained: found.length - unexplained.length,
    };
  }

  /** 本轮是否还有配额。 */
  function quotaFor(turnKey) {
    return quotaByTurn.get(turnKey) ?? 0;
  }

  /** 本轮的某个闸门是否已经触发过。 */
  function kindUsed(turnKey, kind) {
    return kindsByTurn.get(turnKey)?.has(kind) === true;
  }

  /** 记一次干预（同一 kind 每轮最多一次；并裁剪过老的 turnKey，避免内存无限增长）。 */
  function spend(turnKey, kind) {
    quotaByTurn.set(turnKey, quotaFor(turnKey) + 1);
    let kinds = kindsByTurn.get(turnKey);
    if (kinds === undefined) {
      kinds = new Set();
      kindsByTurn.set(turnKey, kinds);
    }
    kinds.add(kind);
    if (quotaByTurn.size > 200) {
      const keys = [...quotaByTurn.keys()];
      for (const key of keys.slice(0, quotaByTurn.size - 100)) {
        quotaByTurn.delete(key);
        kindsByTurn.delete(key);
      }
    }
  }

  /** 把一次干预写进台账（best-effort，失败只记日志）。 */
  function noteSteer(sessionId, kind, message) {
    try {
      if (sessionId === undefined || typeof store?.append !== 'function') return;
      store.append(sessionId, 'steer', { kind, message: truncate(message, 200) });
    } catch (error) {
      console.log(`[perse-proof] 记录闸门干预失败：${errorText(error)}`);
    }
  }

  /** 本会话有没有已核验的结论。 */
  function hasVerified(sessionId) {
    try {
      return claims?.hasVerified?.(sessionId) === true;
    } catch (error) {
      console.log(`[perse-proof] 查询已核验结论失败，按「没有」处理：${errorText(error)}`);
      return false;
    }
  }

  /**
   * 评估一条助手回复。
   * @param {{sessionId?:string, text?:unknown, turnKey?:string}} input
   * @returns {{steer: null|{kind:'claim'|'jargon', message:string}}}
   */
  function evaluate({ sessionId, text, turnKey } = {}) {
    try {
      const body = typeof text === 'string' ? text : '';
      if (body.trim() === '') return { steer: null };
      const key = typeof turnKey === 'string' && turnKey !== '' ? turnKey : String(sessionId ?? 'unknown');
      if (quotaFor(key) >= maxGatesPerTurn) return { steer: null };

      if (claimGateEnabled && !kindUsed(key, 'claim') && scanCompletion(body).hit && !hasVerified(sessionId)) {
        spend(key, 'claim');
        const message = CLAIM_MESSAGE;
        noteSteer(sessionId, 'claim', message);
        return { steer: { kind: 'claim', message } };
      }

      if (jargonEnabled && !kindUsed(key, 'jargon')) {
        const scanned = scanCodenames(body);
        if (scanned.count >= minCodenameCount) {
          spend(key, 'jargon');
          const message = jargonMessage(scanned.samples);
          noteSteer(sessionId, 'jargon', message);
          return { steer: { kind: 'jargon', message } };
        }
      }

      return { steer: null };
    } catch (error) {
      console.log(`[perse-proof] 闸门评估出错，本轮不干预：${errorText(error)}`);
      return { steer: null };
    }
  }

  /** 清空配额记账（测试用）。 */
  function reset() {
    quotaByTurn.clear();
    kindsByTurn.clear();
  }

  /** 当前配额状态（测试/命令用）。 */
  function quota() {
    return {
      maxPerTurn: maxGatesPerTurn,
      turns: Object.fromEntries(quotaByTurn),
      kinds: Object.fromEntries([...kindsByTurn].map(([key, set]) => [key, [...set]])),
      size: quotaByTurn.size,
    };
  }

  return { scanCompletion, scanCodenames, evaluate, reset, quota };
}
