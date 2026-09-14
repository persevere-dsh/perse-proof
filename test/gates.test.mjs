/**
 * gates（B+A 的执行面）单测 —— 覆盖 docs/SPEC.md §5 的 T9 / T10 / T11。
 * 闸门都在 agent/turn-stopping（serial）里跑；这里只测纯判定函数 evaluate()。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createMockCtx, makeTmpDir, removeTmpDir, sha256, writeTmpFile } from './mock-ctx.mjs';

import { resolveConfig } from '../lib/config.js';
import { createStore } from '../lib/store.js';
import { createClaims } from '../lib/claims.js';
import { createGates } from '../lib/gates.js';

const ROOT = makeTmpDir('perse-proof-gates-');
process.env.PERSE_PROOF_HOME = ROOT;
after(() => removeTmpDir(ROOT));

function setup(overrides = {}) {
  const { config } = resolveConfig(overrides);
  const ctx = createMockCtx();
  const store = createStore({ rootDir: ROOT, logger: ctx.logger });
  const claims = createClaims({ store, config, logger: ctx.logger });
  const gates = createGates({ config, logger: ctx.logger, store, claims });
  return { config, ctx, store, claims, gates };
}

test('T9 完成声明闸门: 无 verified claim + "已完成" ⇒ 恰好 1 次注入；有 verified claim ⇒ 0 次', async () => {
  const { gates, claims } = setup();
  const text = '改造已完成，全部通过。';

  const results = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(await gates.evaluate({ sessionId: 'session-t9', text, turnKey: 'turn-1' }));
  }
  const steers = results.map((r) => r?.steer).filter(Boolean);
  assert.equal(steers.length, 1, `同一轮最多干预一次，实际 ${steers.length}：${JSON.stringify(results)}`);
  assert.equal(steers[0].kind, 'claim', `完成声明闸门的 kind 应为 claim，实际 ${steers[0].kind}`);
  assert.equal(typeof steers[0].message, 'string');
  assert.ok(steers[0].message.length > 0, '注入文本不得为空');
  assert.match(
    steers[0].message,
    /证据|未验证|待验证/,
    `注入文本要么要求补证据、要么要求降级措辞，实际：${steers[0].message}`,
  );

  // 有 verified claim ⇒ 不干预
  const verifiedSession = 'session-t9-verified';
  const file = writeTmpFile(ROOT, 'evidence/gate.txt', 'solid');
  const recorded = await claims.record({
    sessionId: verifiedSession,
    claim: '改造已完成',
    level: 'verified',
    evidence: [{ kind: 'file', path: file, sha256: sha256('solid') }],
  });
  assert.equal(recorded?.level, 'verified', '前置条件：应写入一条 verified claim');
  assert.equal(await claims.hasVerified(verifiedSession), true);

  const quiet = await gates.evaluate({ sessionId: verifiedSession, text, turnKey: 'turn-1' });
  assert.equal(quiet?.steer, null, `有 verified claim 时不得干预，实际 ${JSON.stringify(quiet)}`);
});

test('T9 完成声明闸门: 无完成性措辞时不干预', async () => {
  const { gates } = setup();
  const r = await gates.evaluate({ sessionId: 'session-t9b', text: '正在处理，下一步要跑回归。', turnKey: 'turn-1' });
  assert.equal(r?.steer, null, '没有完成性措辞不应干预');
});

test('T10 代号闸门: 未释义代号 ≥2 ⇒ 1 次注入（docs/SPEC.md §5 矩阵原文的 D8/D9/ADJ-5）', async () => {
  const { gates } = setup();
  const r = await gates.evaluate({
    sessionId: 'session-t10',
    text: '结论：D8/D9/ADJ-5 三处都已经调整好了。',
    turnKey: 'turn-1',
  });
  assert.ok(r?.steer, `未释义代号 ≥2 应干预，实际 ${JSON.stringify(r)}`);
  assert.equal(r.steer.kind, 'jargon', `代号闸门的 kind 应为 jargon，实际 ${r.steer.kind}`);
  assert.match(r.steer.message, /白话|代号|解释|名称/, `注入文本应要求改写成"白话名称（代号）"：${r.steer.message}`);
});

test('T10 代号闸门: docs/SPEC.md §3.5 三个正则的覆盖（ADJ-5 / WP8 / S6a）', async () => {
  const { gates } = setup();
  const r = await gates.evaluate({
    sessionId: 'session-t10-patterns',
    text: '结论：ADJ-5 WP8 S6a 三处都已经调整好了。',
    turnKey: 'turn-1',
  });
  assert.ok(r?.steer, `ADJ-5/WP8/S6a ≥2 个未释义代号应干预，实际 ${JSON.stringify(r)}`);
  assert.equal(r.steer.kind, 'jargon');
});

test('T10 代号闸门: 已带括号白话解释 ⇒ 0 次；单个代号 ⇒ 0 次', async () => {
  const { gates } = setup();

  const explained = await gates.evaluate({
    sessionId: 'session-t10b',
    text: '结论：ADJ-5（审批流）/WP8（工作包八）都已经调整好了。',
    turnKey: 'turn-1',
  });
  assert.equal(explained?.steer, null, `带白话解释不得干预，实际 ${JSON.stringify(explained)}`);

  gates.reset();
  const single = await gates.evaluate({
    sessionId: 'session-t10c',
    text: '结论：ADJ-5 已经调整好了。',
    turnKey: 'turn-2',
  });
  assert.equal(single?.steer, null, `单个代号（< minCodenameCount）不得干预，实际 ${JSON.stringify(single)}`);
});

test('T11 闸门配额: 默认 maxGatesPerTurn=1 ⇒ 一轮总注入 1 次，新轮重置', async () => {
  const { gates } = setup();
  const text = 'ADJ-5 WP8 S6a 全部完成，已验证。'; // 同时命中完成声明闸门与代号闸门

  const outcomes = [];
  for (let i = 0; i < 3; i += 1) {
    outcomes.push(await gates.evaluate({ sessionId: 'session-t11', text, turnKey: 'turn-1' }));
  }
  const total = outcomes.map((o) => o?.steer).filter(Boolean).length;
  assert.equal(total, 1, `maxGatesPerTurn=1 ⇒ 一轮总注入次数应为 1，实际 ${total}`);

  const nextTurn = await gates.evaluate({ sessionId: 'session-t11', text, turnKey: 'turn-2' });
  assert.ok(nextTurn?.steer, '新的一轮应重新获得配额');

  gates.reset();
  const afterReset = await gates.evaluate({ sessionId: 'session-t11', text, turnKey: 'turn-1' });
  assert.ok(afterReset?.steer, 'reset() 后同一轮应重新可干预');
  assert.notEqual(gates.quota(), undefined, 'quota() 应可读（至少不是 undefined）');
});

test('T11 闸门配额: maxGatesPerTurn=2 ⇒ 两条闸门各注入一次', async () => {
  const { gates } = setup({ report: { maxGatesPerTurn: 2 } });
  const text = 'ADJ-5 WP8 S6a 全部完成，已验证。';

  const first = await gates.evaluate({ sessionId: 'session-t11b', text, turnKey: 'turn-1' });
  const second = await gates.evaluate({ sessionId: 'session-t11b', text, turnKey: 'turn-1' });
  const kinds = [first?.steer?.kind, second?.steer?.kind].filter(Boolean).sort();
  assert.deepEqual(
    kinds,
    ['claim', 'jargon'],
    `两条闸门应各注入一次（顺序不限），实际 ${JSON.stringify([first, second])}`,
  );

  const third = await gates.evaluate({ sessionId: 'session-t11b', text, turnKey: 'turn-1' });
  assert.equal(third?.steer, null, '配额用尽后不得再干预');
});
