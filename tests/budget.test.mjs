/**
 * budget（C）单测 —— 覆盖 SPEC §5 的 T12（默认关闭、不干扰）＋派发预算提取。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createMockCtx, makeTmpDir, removeTmpDir } from './mock-ctx.mjs';

import { resolveConfig } from '../lib/config.js';
import { createStore } from '../lib/store.js';
import { createBudget } from '../lib/budget.js';

const ROOT = makeTmpDir('perse-proof-budget-');
process.env.PERSE_PROOF_HOME = ROOT;
after(() => removeTmpDir(ROOT));

function setup(overrides = {}) {
  const { config } = resolveConfig(overrides);
  const ctx = createMockCtx();
  const store = createStore({ rootDir: ROOT, logger: ctx.logger });
  const budget = createBudget({ config, logger: ctx.logger, store });
  return { config, ctx, store, budget };
}

const kindsOf = (results) =>
  results.flatMap((r) => r?.alerts ?? []).map((a) => a?.kind);

test('T12 budget 关闭: budget.enabled=false ⇒ 不产生任何 budget 告警', async () => {
  const { config, budget, store } = setup();
  assert.equal(config.budget.enabled, false, '前置条件：C 默认关闭');

  const sessionId = 'session-t12';
  const results = [];
  // 连续 6 轮：有 token 消耗与工具调用，但既无新产物也无台账变更（正是 no-progress 的触发条件）
  for (let i = 0; i < 6; i += 1) {
    results.push(
      await budget.noteTurn({ sessionId, tokens: 12_000, toolCalls: 9, newArtifacts: 0, ledgerWrites: 0 }),
    );
  }
  // 派发声明预算后又大幅超支
  const dispatch = await budget.noteDispatch({ sessionId, tool: 'subagent', prompt: '预算上限: 1 次，只做一件事' });
  for (let i = 0; i < 8; i += 1) {
    results.push(await budget.noteTurn({ sessionId, tokens: 4000, toolCalls: 6, newArtifacts: 0, ledgerWrites: 0 }));
  }

  const kinds = kindsOf(results);
  assert.deepEqual(kinds, [], `budget 关闭时不得产生任何告警，实际 ${JSON.stringify(kinds)}`);
  assert.equal(dispatch?.declaredBudget ?? null, null, '关闭时派发核对不应留下预算判定');

  const records = await store.read(sessionId);
  const budgetAlerts = records.filter(
    (r) => r.type === 'alert' && ['no-progress', 'dispatch-overrun'].includes(r.data?.kind),
  );
  assert.equal(budgetAlerts.length, 0, `store 里不得有 budget 告警，实际 ${JSON.stringify(budgetAlerts)}`);

  await budget.status(sessionId); // 只要求可调用、不抛
});

test('budget 开启: 派发声明预算被提取（≤N 次 / 预算上限:N / maxToolCalls:N）', async () => {
  const { budget, store } = setup({ budget: { enabled: true, dispatchBudgetCheck: true } });

  const a = await budget.noteDispatch({ sessionId: 'session-dispatch-a', tool: 'subagent', prompt: '最多 ≤ 6 次工具调用，只做这一件事' });
  assert.equal(a?.declaredBudget, 6, `"≤ 6 次" 应解析为 6，实际 ${JSON.stringify(a)}`);

  const b = await budget.noteDispatch({ sessionId: 'session-dispatch-b', tool: 'workflow', prompt: '预算上限: 7 次，超出请停下' });
  assert.equal(b?.declaredBudget, 7, `"预算上限: 7 次" 应解析为 7，实际 ${JSON.stringify(b)}`);

  const c = await budget.noteDispatch({ sessionId: 'session-dispatch-c', tool: 'ralph', prompt: 'maxToolCalls: 4' });
  assert.equal(c?.declaredBudget, 4, `"maxToolCalls: 4" 应解析为 4，实际 ${JSON.stringify(c)}`);

  const d = await budget.noteDispatch({ sessionId: 'session-dispatch-d', tool: 'subagent', prompt: '随便做点什么' });
  assert.equal(d?.declaredBudget ?? null, null, `未声明预算应为 null，实际 ${JSON.stringify(d)}`);

  const records = await store.read('session-dispatch-a');
  assert.ok(
    records.some((r) => r.type === 'dispatch' && r.data?.declaredBudget === 6),
    'store 应落一条 dispatch 记录并带 declaredBudget',
  );
});

test('budget 开启: 连续无进展达到 noProgressRounds ⇒ no-progress 告警；有新产物则重置', async () => {
  const { budget } = setup({ budget: { enabled: true, noProgressRounds: 3 } });
  const sessionId = 'session-progress';

  const stalled = [];
  for (let i = 0; i < 4; i += 1) {
    stalled.push(await budget.noteTurn({ sessionId, tokens: 9000, toolCalls: 5, newArtifacts: 0, ledgerWrites: 0 }));
  }
  const kinds = kindsOf(stalled);
  assert.ok(kinds.includes('no-progress'), `连续无进展应报 no-progress，实际 ${JSON.stringify(kinds)}`);

  const progressed = await budget.noteTurn({
    sessionId,
    tokens: 9000,
    toolCalls: 5,
    newArtifacts: ['out/report.md'],
    ledgerWrites: 0,
  });
  assert.ok(
    !(progressed?.alerts ?? []).some((a) => a?.kind === 'no-progress'),
    `有新产物路径的那一轮不应报 no-progress，实际 ${JSON.stringify(progressed?.alerts)}`,
  );
});
