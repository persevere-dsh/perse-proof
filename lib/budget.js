/**
 * perse-proof · lib/budget.js
 *
 * C 面：按轮成本 / 无进展检测 + 派发预算核对（SPEC §3.6）。
 * **默认关闭**（`budget.enabled:false`）：关闭时本模块不产生任何告警、
 * 不写台账、不打日志（测试 T12 会验）。
 */

import { numberOr, intOr, truncate } from './util.js';

/** 从派发提示词里提取「声明预算」（SPEC §3.6）。 */
const DECLARED_BUDGET_PATTERN = /≤\s*(\d+)\s*次|预算上限[:：]?\s*(\d+)|maxToolCalls[:：]?\s*(\d+)/;

/** 派发类工具（与 util.DISPATCH_TOOLS 同源，此处内联避免循环依赖顾虑）。 */
const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph']);

/**
 * @param {{config?:object, logger?:object, store?:object}} deps
 */
export function createBudget({ config, store } = {}) {
  const settings = config?.budget ?? {};
  const enabled = settings.enabled === true;
  const noProgressRounds = Math.max(1, intOr(settings.noProgressRounds, 3));
  const dispatchBudgetCheck = settings.dispatchBudgetCheck !== false;
  const tokenAlerts = settings.tokenAlerts === true;

  /** sessionId → 会话级统计 */
  const sessions = new Map();

  function stateOf(sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { rounds: 0, noProgressStreak: 0, tokens: 0, lastToolCalls: 0, dispatches: [], alerts: [] };
      sessions.set(sessionId, state);
    }
    return state;
  }

  /** 落一条告警：写台账（best-effort）+ 记内存。 */
  function raiseAlert(sessionId, state, kind, detail, message) {
    const alert = { kind, detail, ...(message === undefined ? {} : { message }) };
    state.alerts.push(alert);
    try {
      if (typeof store?.append === 'function') {
        store.append(sessionId, 'alert', { kind, detail, source: 'budget' });
      }
    } catch {
      console.log('[perse-proof] 记录预算告警失败（忽略）');
    }
    console.log(`[perse-proof] 预算告警：${kind} — ${detail}`);
    return alert;
  }

  /** 解析一段提示词里的声明预算。 */
  function declaredBudgetOf(prompt) {
    try {
      if (typeof prompt !== 'string' || prompt === '') return null;
      const match = DECLARED_BUDGET_PATTERN.exec(prompt);
      if (match === null) return null;
      const raw = match[1] ?? match[2] ?? match[3];
      const value = numberOr(raw);
      return value === undefined ? null : Math.trunc(value);
    } catch {
      return null;
    }
  }

  /**
   * 记一轮结束时的统计。
   * @param {{sessionId:string,tokens?:number,toolCalls?:number,newArtifacts?:number,ledgerWrites?:number}} input
   * @returns {{alerts:Array<{kind:string,detail:string,message?:string}>}}
   */
  function noteTurn({ sessionId, tokens, toolCalls, newArtifacts, ledgerWrites } = {}) {
    if (!enabled || typeof sessionId !== 'string' || sessionId === '') return { alerts: [] };
    const state = stateOf(sessionId);
    const alerts = [];
    try {
      state.rounds += 1;
      const calls = Math.max(0, intOr(toolCalls, 0));
      state.lastToolCalls = calls;
      if (Number.isFinite(tokens)) state.tokens += tokens;

      // 派发核对：把本轮工具调用数记到最近一次未结算的派发上（只观测，不阻断）
      if (dispatchBudgetCheck) {
        for (const dispatch of state.dispatches) {
          if (dispatch.over === true) continue;
          dispatch.usedToolCalls += calls;
          if (dispatch.declaredBudget !== null && dispatch.usedToolCalls > dispatch.declaredBudget) {
            dispatch.over = true;
            alerts.push(raiseAlert(
              sessionId,
              state,
              'dispatch-overrun',
              `${dispatch.tool} 声明不超过 ${dispatch.declaredBudget} 次，已观测到 ${dispatch.usedToolCalls} 次调用`,
              truncate(
                `上一轮派发的 ${dispatch.tool} 声明预算 ${dispatch.declaredBudget} 次，目前观测到 ${dispatch.usedToolCalls} 次，`
                + '已经超出。请要么收窄任务范围，要么明确说明超出的理由和新预算。',
                200,
              ),
            ));
          }
        }
      }

      const progressed = Math.max(0, intOr(newArtifacts, 0)) > 0 || Math.max(0, intOr(ledgerWrites, 0)) > 0;
      if (progressed) {
        state.noProgressStreak = 0;
      } else {
        state.noProgressStreak += 1;
        if (state.noProgressStreak % noProgressRounds === 0) {
          alerts.push(raiseAlert(
            sessionId,
            state,
            'no-progress',
            `连续 ${state.noProgressStreak} 轮既没有新产物落盘，台账也没有变化`,
            truncate(
              `已经连续 ${state.noProgressStreak} 轮没有新产物落盘、台账也没有变化。`
              + '请做三件事之一：(1) 收窄到能马上验证的一小步；(2) 交出阶段性报告并说明卡在哪；'
              + '(3) 把已有结论落盘成文件或台账记录。不要继续原地重试。',
              200,
            ),
          ));
        }
      }

      if (tokenAlerts && Number.isFinite(tokens) && tokens > 0) {
        // 仅记录 token 转折点，不做阈值告警（配置里没有阈值）
        state.lastTokens = tokens;
      }
      return { alerts };
    } catch (error) {
      console.log(`[perse-proof] 统计本轮开销失败（忽略）：${error instanceof Error ? error.message : String(error)}`);
      return { alerts };
    }
  }

  /**
   * 记一次派发调用（subagent / workflow / ralph）。
   * @param {{sessionId:string, tool:string, prompt?:string}} input
   * @returns {{declaredBudget:number|null}}
   */
  function noteDispatch({ sessionId, tool, prompt } = {}) {
    if (!enabled || dispatchBudgetCheck === false) return { declaredBudget: null };
    if (typeof sessionId !== 'string' || sessionId === '' || !DISPATCH_TOOLS.has(tool)) {
      return { declaredBudget: null };
    }
    try {
      const declaredBudget = declaredBudgetOf(prompt);
      const state = stateOf(sessionId);
      state.dispatches.push({ tool, declaredBudget, usedToolCalls: 0, over: false, at: Date.now() });
      if (state.dispatches.length > 20) state.dispatches.splice(0, state.dispatches.length - 20);
      try {
        if (typeof store?.append === 'function') {
          store.append(sessionId, 'dispatch', { tool, declaredBudget, at: Date.now() });
        }
      } catch {
        /* 记录失败不影响主流程 */
      }
      return { declaredBudget };
    } catch {
      return { declaredBudget: null };
    }
  }

  /** 当前预算状态（`/proof status` 用）。 */
  function status(sessionId) {
    if (!enabled) {
      return { enabled: false, rounds: 0, noProgressStreak: 0, tokens: 0, dispatches: [], alerts: [] };
    }
    const state = sessions.get(sessionId);
    if (state === undefined) {
      return { enabled: true, rounds: 0, noProgressStreak: 0, tokens: 0, dispatches: [], alerts: [] };
    }
    return {
      enabled: true,
      rounds: state.rounds,
      noProgressStreak: state.noProgressStreak,
      tokens: state.tokens,
      dispatches: state.dispatches.map((item) => ({ ...item })),
      alerts: state.alerts.map((item) => ({ ...item })),
    };
  }

  return { noteTurn, noteDispatch, status, get enabled() { return enabled; } };
}
