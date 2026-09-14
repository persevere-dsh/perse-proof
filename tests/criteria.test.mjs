/**
 * criteria（C1）单测 —— 覆盖 SPEC §5 的 T1 / T2 / T3 / T4。
 * T1 直接测 lib/digest.js（内容摘要剔除易变量）；T2 是 A-CORE 漂移场景的机械判定。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createMockCtx, makeTmpDir, removeTmpDir } from './mock-ctx.mjs';

import { resolveConfig } from '../lib/config.js';
import { contentDigest, normalizeVolatile } from '../lib/digest.js';
import { createStore } from '../lib/store.js';
import { createCriteria } from '../lib/criteria.js';

const ROOT = makeTmpDir('perse-proof-criteria-');
process.env.PERSE_PROOF_HOME = ROOT;
after(() => removeTmpDir(ROOT));

function setup(overrides = {}) {
  const { config } = resolveConfig(overrides);
  const ctx = createMockCtx();
  const store = createStore({ rootDir: ROOT, logger: ctx.logger });
  const criteria = createCriteria({ store, config, logger: ctx.logger });
  return { config, ctx, store, criteria };
}

const BASE_CRITERIA = [
  { id: 'c1', desc: '构建产物存在', check: 'test -f /tmp/build-a1/out.mjs' },
  { id: 'c2', desc: '端口在监听', check: 'curl -sf http://127.0.0.1:3199/health' },
  { id: 'c3', desc: '报告足够新', check: 'stat -c %y out.mjs # 2024-01-02T03:04:05Z' },
  { id: 'c4', desc: '产物哈希一致', check: 'echo sha256:deadbeef12345678' },
];

// 只改易变量：临时目录、端口、时间戳、sha256 片段
const VOLATILE_VARIANT = [
  { id: 'c1', desc: '构建产物存在', check: 'test -f /tmp/build-b9/out.mjs' },
  { id: 'c2', desc: '端口在监听', check: 'curl -sf http://127.0.0.1:3271/health' },
  { id: 'c3', desc: '报告足够新', check: 'stat -c %y out.mjs # 2026-09-14T11:47:00Z' },
  { id: 'c4', desc: '产物哈希一致', check: 'echo sha256:cafebabe99999999' },
];

// 改一句判据措辞（语义变了）
const WORDING_VARIANT = BASE_CRITERIA.map((c) =>
  c.id === 'c1' ? { ...c, desc: '构建产物必须存在', check: 'test -f /tmp/build-a1/out.mjs || exit 1' } : c,
);

test('T1 摘要稳定性: 只改 /tmp 路径、端口、时间戳、sha256 片段 ⇒ contentSha256 不变', () => {
  const a = contentDigest(BASE_CRITERIA);
  const b = contentDigest(VOLATILE_VARIANT);
  assert.match(a, /^[0-9a-f]{64}$/, `摘要应是 sha256 hex，实际 ${a}`);
  assert.equal(a, b, '易变量不得影响 contentSha256');
});

test('T1 摘要稳定性: 改一句判据措辞 ⇒ contentSha256 变', () => {
  const a = contentDigest(BASE_CRITERIA);
  const c = contentDigest(WORDING_VARIANT);
  assert.notEqual(a, c, '判据措辞改变必须让摘要改变');
});

test('T1 摘要稳定性: 归一化正反证据 + 按 id 排序 + 易变量被占位', () => {
  // 关掉归一化：易变量就能改变摘要（说明"不变"确实来自归一化，而不是摘要没覆盖 check 文本）
  assert.notEqual(
    contentDigest(BASE_CRITERIA, { normalize: false }),
    contentDigest(VOLATILE_VARIANT, { normalize: false }),
    'normalize:false 时易变量应影响摘要',
  );

  // 顺序无关（SPEC §3.2：按 id 排序后拼接）
  const shuffled = [BASE_CRITERIA[2], BASE_CRITERIA[0], BASE_CRITERIA[3], BASE_CRITERIA[1]];
  assert.equal(contentDigest(BASE_CRITERIA), contentDigest(shuffled), '判据顺序不应影响摘要');

  const normalized = normalizeVolatile(
    'test -f /tmp/build-a1/out.mjs && curl :3199 @2024-01-02T03:04:05Z sha256:deadbeef12345678',
  );
  assert.equal(typeof normalized, 'string');
  assert.ok(!normalized.includes('build-a1'), `归一化后不应残留临时目录：${normalized}`);
  assert.ok(!normalized.includes('3199'), `归一化后不应残留端口：${normalized}`);
  assert.ok(!normalized.includes('deadbeef'), `归一化后不应残留 sha 片段：${normalized}`);
  assert.ok(!normalized.includes('2024-01-02'), `归一化后不应残留时间戳：${normalized}`);
});

test('T2 A-CORE 漂移: freeze → run(fail=1) → 改判据内容 → run(pass=10) ⇒ drift 且 afterFailure=true', async () => {
  const { criteria, store } = setup();
  const sessionId = 'session-t2';
  const taskId = 'a-core';

  const frozen = await criteria.freeze({
    sessionId,
    taskId,
    criteria: BASE_CRITERIA,
    executor: { path: 'tests/verify.mjs' },
    artifacts: ['out/report.md'],
  });
  assert.equal(typeof frozen?.revision, 'number', `freeze 应返回 revision，实际 ${JSON.stringify(frozen)}`);
  assert.match(String(frozen.contentSha256), /^[0-9a-f]{64}$/);

  const failedRun = await criteria.recordRun({
    sessionId,
    taskId,
    command: 'node tests/verify.mjs',
    executorPath: 'tests/verify.mjs',
    exitCode: 1,
    pass: 3,
    fail: 1,
    skip: 0,
  });
  assert.equal(failedRun?.drift, null, '首次运行没有"上一次判据"可比，不应报漂移');
  assert.equal(failedRun?.criteriaSha, frozen.contentSha256, 'recordRun 应回报当前判据摘要');

  // 判据内容被改：走 amend（唯一被冻结的"改判据"入口），reason 必填
  const amended = await criteria.amend({
    sessionId,
    taskId,
    criteria: WORDING_VARIANT,
    reason: 'A-CORE 判据文件被编辑',
  });
  assert.equal(amended.revision, frozen.revision + 1, 'amend 应产生新 revision');
  assert.notEqual(amended.contentSha256, frozen.contentSha256, '改措辞后摘要应变化');

  const passedRun = await criteria.recordRun({
    sessionId,
    taskId,
    command: 'node tests/verify.mjs',
    executorPath: 'tests/verify.mjs',
    exitCode: 0,
    pass: 10,
    fail: 0,
    skip: 0,
  });
  const drift = passedRun?.drift;
  assert.ok(drift, `fail→改判据→pass 必须产出 drift，实际 ${JSON.stringify(passedRun)}`);
  assert.equal(drift.from, frozen.contentSha256, 'from 应是失败那次运行的判据摘要');
  assert.equal(drift.to, amended.contentSha256, 'to 应是改后判据摘要');
  assert.notEqual(drift.from, drift.to);
  assert.equal(drift.afterFailure, true, 'afterFailure 必须为 true（上一次运行 fail=1）');

  const records = await store.read(sessionId);
  assert.ok(
    records.some((r) => r.type === 'alert' && r.data?.kind === 'criteria-drift'),
    'store 应落一条 criteria-drift 告警记录',
  );
  assert.ok(
    records.some((r) => r.type === 'run' && r.data?.fail === 1 && r.data?.pass === 3),
    'store 应落失败那次 run 记录',
  );
});

test('T2 对照: 判据没被改时重复运行不报漂移；amend 缺 reason 直接报错', async () => {
  const { criteria } = setup();
  const sessionId = 'session-t2b';
  const taskId = 'stable';

  const frozen = await criteria.freeze({ sessionId, taskId, criteria: BASE_CRITERIA });
  await criteria.recordRun({ sessionId, taskId, exitCode: 0, pass: 10, fail: 0, skip: 0 });
  const again = await criteria.recordRun({ sessionId, taskId, exitCode: 0, pass: 10, fail: 0, skip: 0 });
  assert.equal(again?.drift, null, '同一判据重复运行不得报漂移');
  assert.equal(again?.criteriaSha, frozen.contentSha256);

  await assert.rejects(
    async () => {
      await criteria.amend({ sessionId, taskId, criteria: WORDING_VARIANT, reason: '' });
    },
    (error) => {
      assert.match(String(error?.message ?? error), /reason|原因|理由/i, '拒绝原因应指向缺失的 reason');
      return true;
    },
    'amend 缺 reason 必须报错',
  );

  assert.equal(await criteria.current(sessionId, taskId), frozen.revision, '失败的 amend 不得推进 revision');
});

test('T3 执行器同文件: executor.path ∈ 判据引用文件 ⇒ criteria-drift 告警', async () => {
  const { criteria } = setup();
  const sessionId = 'session-t3';

  const sameFile = await criteria.freeze({
    sessionId,
    taskId: 'same-file',
    criteria: [{ id: 'c1', desc: '回归测试全绿', check: 'node tests/check.mjs --verify' }],
    executor: { path: 'tests/check.mjs' },
  });
  const alerts = sameFile?.alerts ?? [];
  assert.equal(alerts.length, 1, `同文件应恰好 1 条告警，实际 ${JSON.stringify(alerts)}`);
  assert.equal(alerts[0].kind, 'criteria-drift');
  assert.match(JSON.stringify(alerts[0]), /executor/i, '告警应指明 executor 与判据同文件');

  const clean = await criteria.freeze({
    sessionId,
    taskId: 'clean',
    criteria: [{ id: 'c1', desc: '回归测试全绿', check: 'node tests/check.mjs --verify' }],
    executor: { path: 'tests/other-runner.mjs' },
  });
  assert.equal((clean?.alerts ?? []).length, 0, '执行器与判据不同文件时不得告警');
});

test('T4 白名单审计: 缺 failureRef 或 reason ⇒ 报错且不写入', async () => {
  const { criteria, store } = setup();
  const sessionId = 'session-t4';

  await assert.rejects(
    async () => {
      await criteria.addAllowlist({ sessionId, file: 'src/a.mjs', pattern: 'TODO', reason: '历史遗留' });
    },
    /failureRef|failure|失败/i,
    '缺 failureRef 必须报错',
  );
  await assert.rejects(
    async () => {
      await criteria.addAllowlist({ sessionId, file: 'src/a.mjs', pattern: 'TODO', failureRef: 'run-17' });
    },
    /reason|原因|理由/i,
    '缺 reason 必须报错',
  );

  const ok = await criteria.addAllowlist({
    sessionId,
    file: 'src/a.mjs',
    pattern: 'TODO',
    reason: '上游未修，临时放行',
    failureRef: 'run-17',
    upstreamId: 'UP-3',
    reviewBy: '2026-10-01',
  });
  assert.equal(ok?.ok, true, `四要素齐全应写入成功，实际 ${JSON.stringify(ok)}`);

  const records = await store.read(sessionId);
  const allow = records.filter((r) => r.type === 'allowlist');
  assert.equal(allow.length, 1, `store 应恰好 1 条 allowlist 记录，实际 ${allow.length}`);
  assert.equal(allow[0].data?.failureRef, 'run-17');
  assert.ok(allow[0].data?.reason, 'allowlist 记录必须带 reason');
  assert.ok(allow[0].data?.addedAt, 'allowlist 记录必须带 addedAt（对抗无时间界的永久放宽）');

  const view = await criteria.list(sessionId);
  assert.equal((view?.allowlist ?? []).length, 1, 'criteria.list 应暴露白名单');
});
