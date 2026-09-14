/**
 * config（SPEC §4）单测 ＋ 插件装配（SPEC §5 的 T13 / T14）。
 * T13 = 能力缺失时降级；T14 = 所有能力关闭时干净退出。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { attempt, captureConsole, createMockCtx, makeTmpDir, removeTmpDir, TOOL_NAMES } from './mock-ctx.mjs';

import { resolveConfig } from '../lib/config.js';
import * as plugin from '../lib/index.js';

const ROOT = makeTmpDir('perse-proof-config-');
process.env.PERSE_PROOF_HOME = ROOT;
after(() => removeTmpDir(ROOT));

const ALL_OFF = {
  report: { enabled: false },
  jargon: { enabled: false },
  claims: { enabled: false },
  criteria: { enabled: false },
  ledger: { enabled: false },
  budget: { enabled: false },
};

function expectKeys(actual, expected, label) {
  assert.equal(typeof actual, 'object', `${label} 应是对象`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${label}.${key} 应为 ${JSON.stringify(value)}，实际 ${JSON.stringify(actual[key])}`);
  }
}

test('config: 默认值即 SPEC §4（C 默认关闭）', () => {
  const { config, warnings } = resolveConfig();
  expectKeys(config.report, { enabled: true, order: 2900, maxGatesPerTurn: 1 }, 'report');
  expectKeys(config.jargon, { enabled: true, minCodenameCount: 2, extraPatterns: [] }, 'jargon');
  expectKeys(
    config.claims,
    { enabled: true, gateOnCompletionClaim: true, strictCommandEvidence: true, allowUnmatchedCommands: false },
    'claims',
  );
  expectKeys(
    config.criteria,
    { enabled: true, driftDetect: true, requireAmendReason: true, normalizeVolatile: true },
    'criteria',
  );
  expectKeys(config.ledger, { enabled: true, todoDropDetect: true, writeAmplifyThreshold: 8 }, 'ledger');
  expectKeys(
    config.budget,
    { enabled: false, noProgressRounds: 3, dispatchBudgetCheck: true, tokenAlerts: false },
    'budget',
  );
  assert.ok(Array.isArray(warnings), 'resolveConfig 应返回 warnings 数组');
});

test('config: 部分覆盖只改指定字段（深合并、不改写入参）', () => {
  const raw = {
    budget: { enabled: true },
    ledger: { writeAmplifyThreshold: 3 },
    report: { maxGatesPerTurn: 2 },
    jargon: { extraPatterns: ['\\bZ\\d+\\b'] },
  };
  const snapshot = JSON.stringify(raw);

  const { config } = resolveConfig(raw);
  assert.equal(config.budget.enabled, true, '覆盖应生效');
  assert.equal(config.budget.noProgressRounds, 3, '未覆盖的同节字段应保留默认值');
  assert.equal(config.ledger.writeAmplifyThreshold, 3, '覆盖应生效');
  assert.equal(config.ledger.todoDropDetect, true, '未覆盖的同节字段应保留默认值');
  assert.equal(config.report.maxGatesPerTurn, 2, '覆盖应生效');
  assert.equal(config.report.order, 2900, '未覆盖的同节字段应保留默认值');
  assert.deepEqual(config.jargon.extraPatterns, ['\\bZ\\d+\\b']);
  assert.equal(config.jargon.minCodenameCount, 2);
  assert.equal(config.claims.enabled, true, '未覆盖的其它节应整体保留默认值');
  assert.equal(config.criteria.enabled, true);
  assert.equal(JSON.stringify(raw), snapshot, 'resolveConfig 不得改写传入的 raw 对象');

  const again = resolveConfig();
  assert.equal(again.config.ledger.writeAmplifyThreshold, 8, '默认值不得被上一次覆盖污染');
});

test('A4: 入口导出形状 —— name 为 perse-proof，不导出 Config，导出 apply', () => {
  assert.equal(plugin.name, 'perse-proof');
  assert.equal(typeof plugin.apply, 'function', 'apply 必须是函数');
  assert.equal(plugin.Config, undefined, 'A4：不导出 Config（避免 schemastery 依赖）');
  // A1：不 inject 任何服务（缺失服务会让 entry 永久 pending 并让 app-boot 拒绝启动）；空数组等价于不写。
  assert.ok(
    plugin.inject === undefined || (Array.isArray(plugin.inject) && plugin.inject.length === 0),
    `不得 inject 服务，实际 ${JSON.stringify(plugin.inject)}`,
  );
});

test('T13 能力缺失降级: 缺 tokenMeter / 投影 API ⇒ apply() 不抛、工具仍注册、只记降级日志', async () => {
  const ctx = createMockCtx({ capabilities: { tokenMeter: false, sessionProjections: false, goals: false } });
  const captured = captureConsole();
  let outcome;
  try {
    outcome = await attempt(() => plugin.apply(ctx, { budget: { enabled: true } }));
  } finally {
    captured.restore();
  }

  assert.equal(outcome.threw, false, `能力缺失时 apply() 不得抛错：${outcome.text}`);

  const names = ctx.__spy.tools.map((def) => def.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort(), `9 个工具应全部注册，实际 ${JSON.stringify(names)}`);
  for (const def of ctx.__spy.tools) {
    assert.equal(typeof def.execute, 'function', `${def.name} 必须用 execute(args, exec)（API-NOTES §3.0）`);
    assert.equal(typeof def.handler, 'undefined', `${def.name} 不得使用 handler 字段`);
    assert.equal(def.parameters?.type, 'object', `${def.name}.parameters 应是原始 JSON Schema 对象`);
    assert.ok(def.description, `${def.name} 应有 description`);
  }
  assert.deepEqual(ctx.__spy.problems, [], `工具定义契约问题：${JSON.stringify(ctx.__spy.problems)}`);

  assert.equal(ctx.__spy.sections.length, 1, '汇报契约段仍应注册');
  assert.equal(ctx.__spy.sections[0].name, 'proof:report-contract');
  assert.equal(ctx.__spy.sections[0].order, 2900, 'order 应取 SECTION_ORDERS.TOOL_REPORT = 2900');

  const commandNames = ctx.__spy.commands.map((cmd) => cmd.name);
  assert.deepEqual(commandNames, ['proof'], `/proof 命令仍应注册，实际 ${JSON.stringify(commandNames)}`);
  assert.equal(ctx.__spy.commands[0].description.length > 0, true, '命令应有非空 description');

  const logText = [
    captured.text(),
    ...ctx.__spy.logs.map((entry) => entry.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
  ].join('\n');
  assert.match(
    logText,
    /降级|不可用|缺失|缺少|未提供|degrad|missing|tokenMeter|sessionProjections/i,
    `能力缺失时应记一条降级日志，实际日志：${JSON.stringify(logText)}`,
  );
});

test('A1#4: getSectionOrder 取不到时回退字面量 2900', async () => {
  const ctx = createMockCtx({ sectionOrders: { TOOL_REPORT: undefined } });
  assert.equal(ctx.systemPrompt.getSectionOrder('TOOL_REPORT'), undefined, '前置条件：模拟 API 取不到 order');
  const outcome = await attempt(() => plugin.apply(ctx, { report: { enabled: true } }));
  assert.equal(outcome.threw, false, `order 取不到时不得抛错：${outcome.text}`);
  const section = ctx.__spy.sections.find((s) => s.name === 'proof:report-contract');
  assert.ok(section, '汇报契约段应注册');
  assert.equal(section.order, 2900, '取不到时应回退字面量 2900');
});

test('T14 全关: 所有能力 enabled:false ⇒ apply() 不注册任何工具/段/监听（干净退出）', async () => {
  const ctx = createMockCtx();
  const captured = captureConsole();
  let outcome;
  try {
    outcome = await attempt(() => plugin.apply(ctx, ALL_OFF));
  } finally {
    captured.restore();
  }

  assert.equal(outcome.threw, false, `全关时 apply() 不得抛错：${outcome.text}`);
  assert.equal(ctx.__spy.tools.length, 0, `不得注册工具，实际 ${JSON.stringify(ctx.__spy.tools.map((t) => t.name))}`);
  assert.equal(ctx.__spy.sections.length, 0, '不得注册系统提示词段');
  assert.equal(ctx.__spy.listeners.size, 0, `不得注册事件监听，实际 ${JSON.stringify([...ctx.__spy.listeners.keys()])}`);
  assert.deepEqual(ctx.__spy.problems, [], `不应产生契约问题：${JSON.stringify(ctx.__spy.problems)}`);
});
