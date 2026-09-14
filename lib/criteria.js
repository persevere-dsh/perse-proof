/**
 * perse-proof · C1 判据冻结 / 变更留痕 / 漂移检测 / 白名单审计
 *
 * 本插件的核心：**判据不能被它自己偷偷改**。
 * 机制：
 *   - 冻结（freeze）把判据规范化后算内容摘要（剔除易变量），写一条只追加的 revision；
 *   - 每次运行（recordRun）与「上一次运行时的判据摘要」比对，不同就是漂移（drift），
 *     并带上「上一次运行是否有失败」这个关键标记（afterFailure）——
 *     这正是 A-CORE 场景的机械判定：免费失败 → 改判据 → 通过，必须留痕；
 *   - 改判据（amend）必须写明原因，且同样带 afterFailure；
 *   - 白名单放宽必须有原因 + 指向一条失败证据，对抗「无时间界的永久放宽」。
 *
 * 依赖全部通过参数注入（不 import 其它模块的单例）；只 import 无状态的 ./digest.js。
 */

import { contentDigest, fileDigest } from './digest.js';

const DEFAULT_TASK = 'default';

/** 与 config 无关的小工具。 */
function num(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function blank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalizeTaskId(taskId) {
  if (blank(taskId)) return DEFAULT_TASK;
  return String(taskId).trim();
}

/** 路径比较用的归一化形式。 */
function normPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim();
}

/** 两个路径指不指同一个文件（允许一个写相对路径、一个写绝对路径）。 */
function samePath(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  if (x.endsWith(`/${y}`) || y.endsWith(`/${x}`)) return true;
  const bx = x.split('/').pop();
  const by = y.split('/').pop();
  if (!x.includes('/') || !y.includes('/')) return bx === by && bx !== '';
  return false;
}

/**
 * 从判据文本里挑出「看起来是文件」的字符串。
 * 只做保守识别：带目录分隔符的，或带扩展名的，或 http(s) 链接。
 */
function referencedFiles(list) {
  const found = new Set();
  for (const item of list) {
    const raw = item && typeof item === 'object' ? `${item.check ?? ''} ${item.desc ?? ''}` : String(item ?? '');
    for (const token of raw.split(/[\s,;:()"'`[\]{}，。；：（）「」【】、]+/)) {
      const t = token.replace(/[。，、）】]+$/g, '').trim();
      if (t.length < 3) continue;
      if (t.startsWith('-')) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
        found.add(t);
        continue;
      }
      if (t.includes('/') || /^[\w.@+-]+\.[A-Za-z0-9]{1,8}$/.test(t)) found.add(normPath(t));
    }
  }
  return [...found];
}

/**
 * 把执行器参数规整成 `{path, sha256?}`；没写路径就当没有执行器。
 * sha256 没给就顺手算一个（用于发现「判据文件被改」）。
 */
function normalizeExecutor(raw) {
  if (typeof raw === 'string') {
    const p = raw.trim();
    return p === '' ? null : normalizeExecutor({ path: p });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pathValue = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (pathValue === '') return null;
  const out = { path: pathValue };
  const declared = typeof raw.sha256 === 'string' ? raw.sha256.trim() : '';
  if (declared !== '') out.sha256 = declared;
  else {
    const digest = fileDigest(pathValue);
    if (digest.ok) out.sha256 = digest.sha256;
  }
  return out;
}

/**
 * @param {{store:any, config?:any, logger?:any}} deps
 */
export function createCriteria(deps) {
  const { store, config, logger } = deps && typeof deps === 'object' ? deps : {};
  const criteriaConfig = () => (config && config.criteria) || {};

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
      warn(`读取记录失败（${error && error.message ? error.message : error}），按空台账继续。`);
      return [];
    }
  }

  function appendRecord(sessionId, type, data) {
    try {
      const result = store.append(sessionId, type, data);
      if (!result || result.ok === false) return false;
      return true;
    } catch (error) {
      warn(`写入记录失败（${error && error.message ? error.message : error}），这条没有存下来。`);
      return false;
    }
  }

  function criteriaRecords(records, taskId) {
    return records.filter((r) => r && r.type === 'criteria' && normalizeTaskId(r.data && r.data.taskId) === taskId);
  }

  function lastCriteria(records, taskId) {
    const list = criteriaRecords(records, taskId);
    return list.length > 0 ? list[list.length - 1] : null;
  }

  function lastRun(records, taskId) {
    const list = records.filter((r) => r && r.type === 'run' && normalizeTaskId(r.data && r.data.taskId) === taskId);
    return list.length > 0 ? list[list.length - 1] : null;
  }

  function digestOf(list) {
    return contentDigest(list, { normalize: criteriaConfig().normalizeVolatile !== false });
  }

  function makeAlert(sessionId, data) {
    appendRecord(sessionId, 'alert', data);
    return data;
  }

  function driftAlert(drift, refs, taskId) {
    const reason = drift.reason;
    let message;
    if (reason === 'executor-changed') {
      message = `判据文件本身被改过了（任务「${taskId}」）：上一次运行之后它变过一次。改判据要留痕，请用「改判据」把新内容与新原因一起记下来。`;
    } else if (reason === 'both') {
      message =
        drift.afterFailure === true
          ? `判据在失败之后被改动了（任务「${taskId}」）：上一次运行有失败项，然后判据的内容和判据文件都变了。这条改动必须留原因。`
          : `判据发生了改动（任务「${taskId}」）：内容和文件都与上一次运行时不一致，请确认这是有意改动并留下原因。`;
    } else {
      message =
        drift.afterFailure === true
          ? `判据在失败之后被改动了（任务「${taskId}」）：上一次运行有失败项，之后判据内容变了，然后才跑出通过。请说明为什么改，别让「改到通过」变成无声操作。`
          : `判据发生了改动（任务「${taskId}」）：本次运行的判据与上一次运行时不一致，请确认是有意改动并留下原因。`;
    }
    return {
      kind: 'criteria-drift',
      detail: reason,
      message,
      taskId,
      from: drift.from,
      to: drift.to,
      afterFailure: drift.afterFailure,
      refs: refs.filter((n) => typeof n === 'number' && n >= 0),
      at: Date.now(),
    };
  }

  return {
    /**
     * 冻结一版判据。
     * @returns {{revision:number, contentSha256:string, alerts:object[], ok:boolean, taskId:string}}
     */
    freeze(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const taskId = normalizeTaskId(input.taskId);
      const list = Array.isArray(input.criteria) ? input.criteria : [];
      const records = readAll(input.sessionId);
      const previous = lastCriteria(records, taskId);
      const revision = num(previous && previous.data && previous.data.revision) + 1;
      const contentSha256 = digestOf(list);
      const executor = normalizeExecutor(input.executor);
      const artifacts = Array.isArray(input.artifacts)
        ? input.artifacts.map((a) => String(a)).filter((a) => a !== '')
        : [];

      const alerts = [];
      const selfRef = records.length;
      if (executor) {
        const refs = referencedFiles(list);
        const hit = refs.find((file) => samePath(file, executor.path));
        if (hit) {
          alerts.push(
            makeAlert(input.sessionId, {
              kind: 'criteria-drift',
              detail: 'executor==criteria file',
              message: `执行器和判据是同一个文件（${executor.path}）：让判据自己跑自己，等于它可以偷偷改判据。请把校验脚本和被测文件分开。`,
              taskId,
              refs: [selfRef],
              at: Date.now(),
            }),
          );
        }
      }

      const record = {
        taskId,
        revision,
        criteria: list,
        contentSha256,
        executor: executor && executor.path ? executor : null,
        artifacts,
        supersedes: previous ? num(previous.data.revision) : null,
        afterFailure: false,
        at: Date.now(),
      };
      const ok = appendRecord(input.sessionId, 'criteria', record);
      return { ok, revision, contentSha256, alerts, taskId };
    },

    /**
     * 改判据：必须写明原因，并记录「上一次运行是否有失败」。
     * reason 为空 → throw（签名明确要求）。
     */
    amend(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason === '') {
        throw new Error('改判据必须写明原因，否则没法追责：请在原因里说清为什么要改。');
      }
      const taskId = normalizeTaskId(input.taskId);
      const records = readAll(input.sessionId);
      const previous = lastCriteria(records, taskId);
      const run = lastRun(records, taskId);
      const afterFailure = run ? num(run.data && run.data.fail) > 0 : false;

      let list = Array.isArray(input.criteria) ? input.criteria : null;
      if (list === null) {
        if (previous && Array.isArray(previous.data && previous.data.criteria)) {
          list = previous.data.criteria;
        } else {
          return {
            ok: false,
            revision: 0,
            contentSha256: null,
            afterFailure,
            taskId,
            errors: ['没有给出新的判据，也找不到可以沿用的旧判据。'],
          };
        }
      }

      const revision = num(previous && previous.data && previous.data.revision) + 1;
      const contentSha256 = digestOf(list);
      const record = {
        taskId,
        revision,
        criteria: list,
        contentSha256,
        executor: previous && previous.data ? previous.data.executor ?? null : null,
        artifacts: previous && previous.data && Array.isArray(previous.data.artifacts) ? previous.data.artifacts : [],
        supersedes: previous ? num(previous.data.revision) : null,
        reason,
        afterFailure,
        at: Date.now(),
      };
      const ok = appendRecord(input.sessionId, 'criteria', record);
      return { ok, revision, contentSha256, afterFailure, taskId, reason };
    },

    /** 当前判据版本号；没有冻结过返回 null。 */
    current(sessionId, taskId) {
      const task = normalizeTaskId(taskId);
      const previous = lastCriteria(readAll(sessionId), task);
      return previous ? num(previous.data && previous.data.revision) : null;
    },

    /**
     * 记录一次运行，并与上一次运行的判据摘要比对，产出漂移标记。
     * @returns {{criteriaSha:string|null, drift:null|{from:any,to:any,afterFailure:boolean}, ok:boolean, taskId:string, alert:object|null}}
     */
    recordRun(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const taskId = normalizeTaskId(input.taskId);
      const records = readAll(input.sessionId);
      const current = lastCriteria(records, taskId);
      const criteriaSha = current ? (current.data && current.data.contentSha256) ?? null : null;
      const previousRun = lastRun(records, taskId);
      const previousCriteriaSha = previousRun ? (previousRun.data && previousRun.data.criteriaSha) ?? null : null;
      const previousFail = previousRun ? num(previousRun.data && previousRun.data.fail) : 0;

      const executorPath = blank(input.executorPath) ? null : String(input.executorPath);
      let executorSha = null;
      if (executorPath) {
        const digest = fileDigest(executorPath);
        if (digest.ok) executorSha = digest.sha256;
      }

      let drift = null;
      if (previousRun) {
        const criteriaChanged = previousCriteriaSha !== criteriaSha;
        const previousExecutorSha =
          previousRun.data && typeof previousRun.data.executorSha === 'string' ? previousRun.data.executorSha : null;
        const executorChanged =
          executorSha !== null && previousExecutorSha !== null && executorSha !== previousExecutorSha;
        if (criteriaChanged || executorChanged) {
          drift = {
            from: previousCriteriaSha,
            to: criteriaSha,
            afterFailure: previousFail > 0,
            reason:
              criteriaChanged && executorChanged ? 'both' : executorChanged ? 'executor-changed' : 'criteria-changed',
            executorFrom: previousExecutorSha,
            executorTo: executorSha,
          };
        }
      }

      const data = {
        taskId,
        criteriaSha,
        criteriaRevision: current ? num(current.data && current.data.revision) : null,
        executorPath,
        executorSha,
        command: blank(input.command) ? null : String(input.command),
        exitCode: input.exitCode === undefined || input.exitCode === null ? null : num(input.exitCode),
        pass: num(input.pass),
        fail: num(input.fail),
        skip: num(input.skip),
        outputSha256: blank(input.outputSha256) ? null : String(input.outputSha256),
        at: Date.now(),
      };
      const runSeq = records.length;
      const ok = appendRecord(input.sessionId, 'run', data);

      let alert = null;
      if (drift && criteriaConfig().driftDetect !== false) {
        alert = makeAlert(input.sessionId, driftAlert(drift, [previousRun.seq, runSeq], taskId));
      }
      return { criteriaSha, drift, ok, taskId, alert };
    },

    /**
     * 加白名单：必须写明原因 + 指向一条失败证据。
     * 缺字段 → throw（签名明确要求）。
     * @returns {{ok:boolean}}
     */
    addAllowlist(payload) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const missing = [];
      if (blank(input.file)) missing.push('要放宽的是哪个文件');
      if (blank(input.pattern)) missing.push('放宽的是哪一类问题（匹配样式）');
      if (blank(input.reason)) missing.push('为什么可以放宽');
      if (blank(input.failureRef)) missing.push('这条放宽对应的是哪一条失败记录');
      if (missing.length > 0) {
        throw new Error(
          `白名单缺了必需的信息：${missing.join('、')}。没有原因和失败记录的放宽等于永久后门，所以拒绝登记。`,
        );
      }
      const data = {
        file: String(input.file).trim(),
        pattern: String(input.pattern).trim(),
        reason: String(input.reason).trim(),
        failureRef: String(input.failureRef).trim(),
        upstreamId: blank(input.upstreamId) ? null : String(input.upstreamId).trim(),
        reviewBy: blank(input.reviewBy) ? null : String(input.reviewBy).trim(),
        addedAt: Date.now(),
      };
      const ok = appendRecord(input.sessionId, 'allowlist', data);
      return { ok, file: data.file, pattern: data.pattern };
    },

    /**
     * 列出本会话的判据版本与白名单。
     * @returns {{tasks:Record<string,{revisions:object[],runs:object[]}>, allowlist:object[]}}
     */
    list(sessionId) {
      const records = readAll(sessionId);
      const tasks = {};
      for (const record of records) {
        if (!record || record.type !== 'criteria') continue;
        const taskId = normalizeTaskId(record.data && record.data.taskId);
        if (!tasks[taskId]) tasks[taskId] = { taskId, revisions: [], runs: [] };
        const data = record.data || {};
        tasks[taskId].revisions.push({
          revision: num(data.revision),
          contentSha256: data.contentSha256 ?? null,
          criteria: Array.isArray(data.criteria) ? data.criteria : [],
          executor: data.executor ?? null,
          artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
          reason: data.reason ?? null,
          supersedes: data.supersedes ?? null,
          afterFailure: data.afterFailure === true,
          at: data.at ?? record.ts ?? null,
          seq: record.seq,
        });
      }
      for (const record of records) {
        if (!record || record.type !== 'run') continue;
        const taskId = normalizeTaskId(record.data && record.data.taskId);
        if (!tasks[taskId]) tasks[taskId] = { taskId, revisions: [], runs: [] };
        const data = record.data || {};
        tasks[taskId].runs.push({
          criteriaSha: data.criteriaSha ?? null,
          command: data.command ?? null,
          executorPath: data.executorPath ?? null,
          exitCode: data.exitCode ?? null,
          pass: num(data.pass),
          fail: num(data.fail),
          skip: num(data.skip),
          at: data.at ?? record.ts ?? null,
          seq: record.seq,
        });
      }
      for (const task of Object.values(tasks)) {
        task.revisions.sort((a, b) => a.revision - b.revision);
        if (task.revisions.length > 0) {
          const latest = task.revisions[task.revisions.length - 1];
          for (const rev of task.revisions) rev.isCurrent = rev.seq === latest.seq;
        }
      }
      const allowlist = records
        .filter((r) => r && r.type === 'allowlist')
        .map((r) => ({ ...(r.data || {}), seq: r.seq }));
      return { tasks, allowlist };
    },
  };
}
