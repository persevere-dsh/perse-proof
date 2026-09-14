/**
 * perse-proof · 摘要与哈希
 *
 * 目的：判据文本里有一类「容易变的量」（临时路径、端口、时间戳、运行编号、sha 片段）。
 * 它们一变，内容摘要就变，漂移检测就会天天误报。所以先把这些量抹成占位符，再算 sha256：
 * **只有实质改动才会让摘要变**。
 *
 * 依赖：仅 node: 内置模块（零外部依赖）。
 * 本模块是纯函数模块，不持有状态，可被其它模块直接 import。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 易变量占位符（中文，方便直接打进告警文本里给人看）。 */
const P = {
  sha: '<摘要片段>',
  time: '<时间>',
  runId: '<运行编号>',
  port: '<端口>',
  winPath: '<路径>',
  tmpPath: '<临时路径>',
  path: '<路径>',
};

// 顺序有讲究：先长后短、先特例后通配。
// 1) sha256:xxxx 片段
const RE_SHA = /sha256:[0-9a-f]{6,}/gi;
// 2) RFC 2822 时间戳（Mon, 02 Jan 2024 03:04:05 GMT）
const RE_RFC_TIME =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+(?:GMT|UTC|UT|[+-]\d{4}))?\b/gi;
// 3) ISO 8601 时间戳（2024-01-02T03:04:05.123Z / 2024-01-02 03:04:05+08:00）
const RE_ISO_TIME =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
// 4) 裸时钟（先带秒，再分钟；必须走在端口号前面，否则 03:04:05 会被拆成端口）
const RE_CLOCK = /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,9})?\b/g;
const RE_CLOCK_MIN = /\b\d{1,2}:\d{2}\b/g;
// 5) 运行编号 run-xxxx / run_xxxx
const RE_RUN_ID = /\brun[-_][0-9A-Za-z][0-9A-Za-z_-]*/g;
// 6) Windows 绝对路径（C:\x\y 或 C:/x/y）
const RE_WIN_PATH = /\b[A-Za-z]:[\\/][\w.@+-]+(?:[\\/][\w.@+-]+)*/g;
// 7) 临时目录（/tmp/...、/private/tmp/...、/var/folders/...）
const RE_TMP_PATH = /\/(?:tmp|private\/tmp|var\/folders|private\/var\/folders)(?:\/[\w.@+-]+)*/g;
// 8) 端口号 :1234（必须在时间戳/时钟之后再跑）
const RE_PORT = /:(\d{2,5})\b/g;
// 9) 其余绝对路径（/Users/... 等）；前面不能是 / 或单词字符，避免啃掉 URL 的协议头
const RE_ABS_PATH = /(?<![\/\w])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g;

/**
 * 把「容易变的量」替换成占位符。同一段判据只改这些量时，输出必须逐字相同。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeVolatile(text) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  out = out.replace(RE_SHA, P.sha);
  out = out.replace(RE_RFC_TIME, P.time);
  out = out.replace(RE_ISO_TIME, P.time);
  out = out.replace(RE_CLOCK, P.time);
  out = out.replace(RE_CLOCK_MIN, P.time);
  out = out.replace(RE_RUN_ID, P.runId);
  out = out.replace(RE_WIN_PATH, P.winPath);
  out = out.replace(RE_TMP_PATH, P.tmpPath);
  out = out.replace(RE_PORT, `:${P.port}`);
  out = out.replace(RE_ABS_PATH, P.path);
  return out;
}

/** sha256 → 小写十六进制。字符串按 utf8，其余按字节。 */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** 折叠空白 + 去首尾空白。 */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把判据列表整理成规范形式：按 id 排序、trim、折叠空白。
 * 兼容传入「数组」或「带 criteria 字段的对象」。
 * @returns {{id:string, desc:string, check:string, index:number}[]}
 */
function canonicalEntries(criteria) {
  const list = Array.isArray(criteria)
    ? criteria
    : criteria && Array.isArray(criteria.criteria)
      ? criteria.criteria
      : [];
  const items = list.map((raw, index) => {
    if (typeof raw === 'string') return { id: '', desc: '', check: collapse(raw), index };
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const id = collapse(item.id);
    return {
      id: id !== '' ? id : collapse(item.name),
      desc: collapse(item.desc),
      check: collapse(item.check),
      index,
    };
  });
  // 按 id 排序；id 相同或缺失时保持原顺序（稳定排序）。
  items.sort((a, b) => (a.id === b.id ? a.index - b.index : a.id < b.id ? -1 : 1));
  return items;
}

/**
 * 判据内容摘要。
 * @param {unknown} criteria 判据数组（或含 criteria 的对象）
 * @param {{normalize?: boolean}} [opts] normalize 默认 true（剔除易变量）
 * @returns {string} sha256 十六进制
 */
export function contentDigest(criteria, opts) {
  const normalize = !(opts && opts.normalize === false);
  const lines = canonicalEntries(criteria).map((entry) => {
    const raw = `id=${entry.id}\ndesc=${entry.desc}\ncheck=${entry.check}`;
    return normalize ? normalizeVolatile(raw) : raw;
  });
  return sha256Hex(lines.join('\n---\n'));
}

/**
 * 任意文本摘要。
 * @param {unknown} text
 * @returns {string} sha256 十六进制
 */
export function textDigest(text) {
  return sha256Hex(typeof text === 'string' ? text : String(text ?? ''));
}

/** 把 node 的 fs 错误翻译成人话。 */
function describeFsError(error, filePath) {
  const code = error && error.code;
  if (code === 'ENOENT') return `文件不存在：${filePath}`;
  if (code === 'EISDIR') return `这是一个目录，不是文件：${filePath}`;
  if (code === 'EACCES' || code === 'EPERM') return `没有权限读这个文件：${filePath}`;
  if (code === 'ENOTDIR') return `路径中间有一段不是目录：${filePath}`;
  const message = error && error.message ? error.message : String(error);
  return `读取失败：${filePath}（${message}）`;
}

/**
 * 读文件算 sha256。
 * @param {unknown} filePath
 * @returns {{ok:true, sha256:string, bytes:number}|{ok:false, error:string}}
 */
export function fileDigest(filePath) {
  try {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return { ok: false, error: '没有给出文件路径' };
    }
    const buf = readFileSync(filePath);
    return { ok: true, sha256: sha256Hex(buf), bytes: buf.length };
  } catch (error) {
    return { ok: false, error: describeFsError(error, String(filePath)) };
  }
}
