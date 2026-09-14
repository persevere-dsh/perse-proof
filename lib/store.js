/**
 * perse-proof · 文件仓库
 *
 * 为什么不写会话事件：docs/ADDENDUM-A.md §A1#1 —— `session.append` 写不出 `ignorable` 标记，
 * 而 rc.2 的持久化读取侧对「仓库外的事件类型且没带该标记」一律 throw（会话重启后读不出来）。
 * 所以本插件的全部持久状态改为**文件追加**：
 *
 *   ~/.dsh/proof/<sessionId>.jsonl     每行一条 {ts, type, data}，只追加
 *   ~/.dsh/proof/<sessionId>.meta.json  {sessionId, cwd, firstSeenAt, lastSeenAt}（可覆盖更新）
 *
 * 根目录可用环境变量 `PERSE_PROOF_HOME` 覆盖（测试与影子模式）。
 * 硬规则：**绝不抛错到调用方**；坏行跳过并计数，写失败只 console.log 告警。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 环境变量覆盖优先于用户目录，显式传入的 rootDir 优先于两者。 */
function defaultRootDir() {
  const env = process.env.PERSE_PROOF_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(homedir(), '.dsh', 'proof');
}

/** 会话 id 只用来拼文件名，必须洗掉路径分隔符之类的东西。 */
function safeSessionId(sessionId) {
  const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId);
  const cleaned = raw.replace(/[^0-9A-Za-z_@.-]/g, '_').replace(/^\.+/, '_').slice(0, 160);
  return cleaned === '' ? 'unknown-session' : cleaned;
}

function errorText(error) {
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

/** 一行是否是一条可用的记录。 */
function parseLine(line) {
  const text = line.trim();
  if (text === '') return { ok: false, skip: true };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, skip: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, skip: false };
  if (typeof parsed.type !== 'string' || parsed.type === '') return { ok: false, skip: false };
  return { ok: true, value: parsed };
}

/**
 * 建一个文件仓库。
 * @param {{rootDir?: string, logger?: any}} [options]
 */
export function createStore(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const logger = opts.logger;
  const rootDir =
    typeof opts.rootDir === 'string' && opts.rootDir.trim() !== ''
      ? path.resolve(opts.rootDir.trim())
      : defaultRootDir();

  /** @type {Map<string, object>} */
  const metaCache = new Map();
  /** @type {Map<string, number>} */
  const metaTouchedAt = new Map();

  function warn(message) {
    const text = `[perse-proof] ${message}`;
    try {
      console.log(text);
    } catch {
      /* 连 console 都不可用时也不许炸 */
    }
    if (logger && typeof logger.info === 'function') {
      try {
        logger.info(text);
      } catch {
        /* logger 坏了不影响本插件 */
      }
    }
  }

  function fileOf(sessionId) {
    return path.join(rootDir, `${safeSessionId(sessionId)}.jsonl`);
  }

  function metaFileOf(sessionId) {
    return path.join(rootDir, `${safeSessionId(sessionId)}.meta.json`);
  }

  function ensureDir() {
    mkdirSync(rootDir, { recursive: true });
  }

  function readTextOf(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      warn(`读取记录文件失败（${errorText(error)}），本次按「没有记录」处理。`);
      return null;
    }
  }

  /**
   * 追加一条记录。
   * @returns {{ok:true, ts:number}|{ok:false, error:string}}
   */
  function append(sessionId, type, data) {
    try {
      const recordType = typeof type === 'string' && type.trim() !== '' ? type.trim() : null;
      if (recordType === null) {
        warn('有一条记录没有写明类型，已丢弃。');
        return { ok: false, error: '记录类型为空' };
      }
      let payload;
      try {
        payload = JSON.parse(JSON.stringify(data === undefined ? null : data));
      } catch (error) {
        warn(`有一条记录装不进文本格式（${errorText(error)}），已丢弃。`);
        return { ok: false, error: '记录内容无法序列化' };
      }
      ensureDir();
      const ts = Date.now();
      appendFileSync(fileOf(sessionId), `${JSON.stringify({ ts, type: recordType, data: payload })}\n`, 'utf8');
      touchMeta(sessionId);
      return { ok: true, ts };
    } catch (error) {
      warn(`写入记录失败（${errorText(error)}），这条记录没有存下来。`);
      return { ok: false, error: errorText(error) };
    }
  }

  /**
   * 读全部记录（坏行跳过；seq 按可解析记录的顺序补 0,1,2…）。
   * @returns {Array<{ts:number, type:string, data:any, seq:number}>}
   */
  function read(sessionId) {
    try {
      const text = readTextOf(fileOf(sessionId));
      if (text === null) return [];
      const out = [];
      for (const line of text.split('\n')) {
        const parsed = parseLine(line);
        if (parsed.skip) continue;
        if (!parsed.ok) continue;
        out.push({ ...parsed.value, seq: out.length });
      }
      return out;
    } catch (error) {
      warn(`读取记录时出错（${errorText(error)}），已按空台账继续。`);
      return [];
    }
  }

  /**
   * 计数：records = 能读出来的记录条数；corrupt = 读不出来的行数。
   * @returns {{records:number, corrupt:number}}
   */
  function counts(sessionId) {
    let records = 0;
    let corrupt = 0;
    try {
      const text = readTextOf(fileOf(sessionId));
      if (text === null) return { records: 0, corrupt: 0 };
      for (const line of text.split('\n')) {
        const parsed = parseLine(line);
        if (parsed.skip) continue;
        if (parsed.ok) records += 1;
        else corrupt += 1;
      }
    } catch (error) {
      warn(`统计记录时出错（${errorText(error)}），结果可能不准。`);
    }
    return { records, corrupt };
  }

  /**
   * 维护 <sessionId>.meta.json（尽力而为，失败只告警）。
   * @param {string} sessionId
   * @param {object} [patch] 额外写入的字段（如 cwd）
   */
  function touchMeta(sessionId, patch) {
    try {
      const key = safeSessionId(sessionId);
      const now = Date.now();
      const last = metaTouchedAt.get(key) ?? 0;
      const cached = metaCache.get(key);
      if (cached && now - last < 2000 && (!patch || Object.keys(patch).length === 0)) return cached;
      const file = metaFileOf(sessionId);
      let current = cached ?? null;
      if (!current) {
        const text = readTextOf(file);
        if (text !== null) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
          } catch {
            /* meta 坏了就当空的，不影响主流程 */
          }
        }
      }
      const next = {
        sessionId: sessionId === undefined || sessionId === null ? key : String(sessionId),
        cwd: current && typeof current.cwd === 'string' ? current.cwd : undefined,
        firstSeenAt: current && typeof current.firstSeenAt === 'number' ? current.firstSeenAt : now,
        lastSeenAt: now,
        ...(current ?? {}),
        ...(patch && typeof patch === 'object' ? patch : {}),
      };
      next.sessionId =
        sessionId === undefined || sessionId === null ? key : String(sessionId);
      next.lastSeenAt = now;
      if (typeof next.firstSeenAt !== 'number') next.firstSeenAt = now;
      if (next.cwd === undefined) delete next.cwd;
      ensureDir();
      writeFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
      metaCache.set(key, next);
      metaTouchedAt.set(key, now);
      return next;
    } catch (error) {
      warn(`更新会话信息失败（${errorText(error)}），不影响正常记录。`);
      return null;
    }
  }

  /** 读会话信息；没有就返回 null。 */
  function meta(sessionId) {
    try {
      const key = safeSessionId(sessionId);
      if (metaCache.has(key)) return metaCache.get(key);
      const text = readTextOf(metaFileOf(sessionId));
      if (text === null) return null;
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metaCache.set(key, parsed);
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  return { append, read, counts, meta, touchMeta, fileOf, rootDir };
}
