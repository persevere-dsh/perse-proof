/**
 * ledger（C3）单测 —— 覆盖 docs/SPEC.md §5 的 T5 / T6，外加台账基本读写与 file 证据 sha 校验。
 * 全部离线：只写 os.tmpdir() 下的临时目录，绝不碰用户目录。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  attempt,
  createMockCtx,
  failText,
  failed,
  makeTmpDir,
  removeTmpDir,
  sha256,
  writeTmpFile,
} from './mock-ctx.mjs';

import { resolveConfig } from '../lib/config.js';
import { createStore } from '../lib/store.js';
import { createLedger } from '../lib/ledger.js';

const ROOT = makeTmpDir('perse-proof-ledger-');
process.env.PERSE_PROOF_HOME = ROOT; // 兜底：任何回落到环境变量的路径也只写临时目录
after(() => removeTmpDir(ROOT));

function setup(overrides = {}) {
  const { config } = resolveConfig(overrides);
  const ctx = createMockCtx();
  const store = createStore({ rootDir: ROOT, logger: ctx.logger });
  const ledger = createLedger({ store, config, logger: ctx.logger });
  return { config, ctx, store, ledger };
}

const isAlert = (kind) => (a) => a?.kind === kind;

test('T5 todo 丢项: 3 项 pending → 下次清单只剩 1 项 ⇒ 恰好 1 条 todo-drop + 一次注入文本', async () => {
  const { store, ledger } = setup();
  const sessionId = 'session-t5';

  const baseline = [
    { content: '写 mock', status: 'pending' },
    { content: '写测试', status: 'pending' },
    { content: '跑测试', status: 'pending' },
  ];
  const first = await ledger.noteTodoList(sessionId, baseline);
  assert.equal((first?.alerts ?? []).length, 0, '首次上报只是建立基线，不应告警');

  const second = await ledger.noteTodoList(sessionId, [{ content: '写测试', status: 'in_progress' }]);
  const alerts = second?.alerts ?? [];
  assert.equal(alerts.length, 1, `应恰好 1 条告警，实际 ${alerts.length}：${JSON.stringify(alerts)}`);
  assert.ok(isAlert('todo-drop')(alerts[0]), `告警类型应为 todo-drop，实际 ${alerts[0]?.kind}`);
  const alertText = JSON.stringify(alerts[0]);
  assert.ok(alertText.includes('写 mock'), `告警应列出消失条目「写 mock」，实际：${alertText}`);
  assert.ok(alertText.includes('跑测试'), `告警应列出消失条目「跑测试」，实际：${alertText}`);

  // 与 docs/SPEC.md §2 一致：同时落一条 append-only 的 alert 记录
  const records = await store.read(sessionId);
  const persisted = records.filter((r) => r.type === 'alert' && r.data?.kind === 'todo-drop');
  assert.equal(persisted.length, 1, `store 里应有 1 条 todo-drop 记录，实际 ${persisted.length}`);

  // 同一清单重复上报不重复告警
  const third = await ledger.noteTodoList(sessionId, [{ content: '写测试', status: 'in_progress' }]);
  assert.equal((third?.alerts ?? []).length, 0, '同一清单重复上报不应重复告警');
});

test('T6 写放大: 同一路径 9 次 edit ⇒ 恰好 1 条 write-amplify，且不重复', async () => {
  const { store, ledger } = setup();
  const sessionId = 'session-t6';
  const target = '/work/src/thing.mjs';
  const edit = () =>
    ledger.noteToolCall({
      sessionId,
      name: 'edit',
      args: { file_path: target },
      toolResult: { isError: false },
    });

  const collected = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await edit();
    collected.push(...(r?.alerts ?? []));
  }
  assert.equal(
    collected.filter(isAlert('write-amplify')).length,
    0,
    `阈值 8 以下不应告警，实际在第 7 次就报了：${JSON.stringify(collected)}`,
  );

  for (let i = 7; i < 9; i += 1) {
    const r = await edit();
    collected.push(...(r?.alerts ?? []));
  }
  const amplify = collected.filter(isAlert('write-amplify'));
  assert.equal(amplify.length, 1, `9 次 edit 应恰好 1 条 write-amplify，实际 ${amplify.length}`);

  for (let i = 9; i < 12; i += 1) {
    const r = await edit();
    collected.push(...(r?.alerts ?? []));
  }
  assert.equal(
    collected.filter(isAlert('write-amplify')).length,
    1,
    '同一路径同一会话只应报一次 write-amplify',
  );

  const records = await store.read(sessionId);
  assert.equal(
    records.filter((r) => r.type === 'alert' && r.data?.kind === 'write-amplify').length,
    1,
    'store 里应恰好 1 条 write-amplify 记录',
  );

  const stats = await ledger.stats(sessionId);
  const top = (stats?.topRewritten ?? []).find((entry) => entry?.path === target);
  assert.ok(top, `/proof status 的 topRewritten 应包含 ${target}，实际：${JSON.stringify(stats?.topRewritten)}`);
  assert.ok(top.count >= 8, `重写次数应 ≥ 8，实际 ${top.count}`);
});

test('ledger: fact 写入/读回，file 证据 sha 不符时拒绝写入', async () => {
  const { ledger } = setup();
  const sessionId = 'session-facts';
  const file = writeTmpFile(ROOT, 'evidence/a.txt', 'hello');

  const ok = await attempt(() =>
    ledger.setFact({
      sessionId,
      key: 'build',
      value: 'ok',
      evidence: [{ kind: 'file', path: file, sha256: sha256('hello') }],
      note: '构建通过',
    }),
  );
  assert.equal(failed(ok), false, `正确 sha 应被接受，实际：${failText(ok)}`);

  const facts = await ledger.facts(sessionId);
  assert.equal(facts?.build?.value, 'ok', `facts() 应读回 build=ok，实际：${JSON.stringify(facts)}`);
  assert.ok(Array.isArray(facts.build.evidence) && facts.build.evidence.length === 1, 'facts() 应带 1 条证据');
  assert.ok(facts.build.at, 'facts() 应带写入时间');

  const bad = await attempt(() =>
    ledger.setFact({
      sessionId,
      key: 'bad',
      value: 'x',
      evidence: [{ kind: 'file', path: file, sha256: '0'.repeat(64) }],
    }),
  );
  assert.ok(failed(bad), 'sha 不符必须被拒');
  assert.match(failText(bad), /sha|摘要|哈希/i, `错误信息应给出 sha 线索，实际：${failText(bad)}`);

  const after = await ledger.facts(sessionId);
  assert.equal(after?.bad, undefined, '被拒的 fact 不得写入台账');
});

test('T8j ledger.setFact: 声明退出码而记录读不到 ⇒ 不写入该事实（对照：读得到则写入）', async () => {
  const { ledger } = setup();

  // 对照：记录里读得到退出码 0 ⇒ 该 key 正常写入
  const okSession = 'session-t8j-ok';
  await ledger.noteToolCall({ sessionId: okSession, name: 'bash', args: { command: 'npm test' }, toolResult: { exitCode: 0 } });
  const ok = await attempt(() =>
    ledger.setFact({
      sessionId: okSession,
      key: 'cmd-fact-ok',
      value: 'ok',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
    }),
  );
  assert.equal(failed(ok), false, `记录里读得到退出码时应写入，实际：${failText(ok)}`);
  assert.equal((await ledger.facts(okSession))['cmd-fact-ok']?.value, 'ok');

  // 收紧：记录存在但读不到退出码（toolResult 里没有 exitCode）⇒ 不得写入
  const badSession = 'session-t8j-bad';
  await ledger.noteToolCall({ sessionId: badSession, name: 'bash', args: { command: 'npm test' }, toolResult: {} });
  const bad = await attempt(() =>
    ledger.setFact({
      sessionId: badSession,
      key: 'cmd-fact',
      value: 'ok',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
    }),
  );
  assert.ok(failed(bad), `声明了退出码却读不到，必须拒绝写入，实际 ${JSON.stringify(bad.result ?? bad.text)}`);
  assert.match(
    failText(bad),
    /strictCommandEvidence|命令证据/,
    `错误文案应指向命令证据核对，实际：${failText(bad)}`,
  );
  const facts = await ledger.facts(badSession);
  assert.equal(
    facts['cmd-fact'],
    undefined,
    `facts() 里不应出现该 key，实际 ${JSON.stringify(Object.keys(facts))}`,
  );
});

test('T8o noteToolCall 如实记录退出码来源：无标记但未失败 ⇒ inferred-ok/0；显式标记 ⇒ reported/0', async () => {
  const { ledger, store } = setup();

  const inferredSession = 'session-t8o-inferred';
  await ledger.noteToolCall({
    sessionId: inferredSession,
    name: 'bash',
    args: { command: 'npm test' },
    toolResult: { isError: false },
  });
  const inferred = (await store.read(inferredSession)).filter((r) => r.type === 'toolcall').at(-1);
  assert.equal(
    inferred?.data?.exitCodeSource,
    'inferred-ok',
    `无标记且未失败应记为 inferred-ok，实际 ${JSON.stringify(inferred?.data?.exitCodeSource)}`,
  );
  assert.equal(inferred?.data?.exitCode, 0, `inferred-ok 的退出码应为 0，实际 ${JSON.stringify(inferred?.data?.exitCode)}`);

  const reportedSession = 'session-t8o-reported';
  await ledger.noteToolCall({
    sessionId: reportedSession,
    name: 'bash',
    args: { command: 'npm test' },
    toolResult: { content: [{ type: 'text', text: 'ran\n[exit code: 0]' }] },
  });
  const reported = (await store.read(reportedSession)).filter((r) => r.type === 'toolcall').at(-1);
  assert.equal(
    reported?.data?.exitCodeSource,
    'reported',
    `显式标记应记为 reported，实际 ${JSON.stringify(reported?.data?.exitCodeSource)}`,
  );
  assert.equal(reported?.data?.exitCode, 0);
});

test('T8p isError:true 且无标记 + 声明 exitCode:0 ⇒ ledger.setFact 不写入', async () => {
  const { ledger } = setup();
  const sessionId = 'session-t8p';
  await ledger.noteToolCall({ sessionId, name: 'bash', args: { command: 'npm test' }, toolResult: { isError: true } });

  const res = await attempt(() =>
    ledger.setFact({
      sessionId,
      key: 'failed-run-fact',
      value: '测试通过',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
    }),
  );
  assert.ok(failed(res), `明确失败的记录不得支撑该事实，实际 ${JSON.stringify(res.result ?? res.text)}`);
  const facts = await ledger.facts(sessionId);
  assert.equal(
    facts['failed-run-fact'],
    undefined,
    `facts() 里不应出现该 key，实际 ${JSON.stringify(Object.keys(facts))}`,
  );
});
