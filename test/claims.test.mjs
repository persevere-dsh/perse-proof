/**
 * claims（C2）单测 —— 覆盖 docs/SPEC.md §5 的 T7 / T8。
 *
 * 说明：docs/ADDENDUM-A.md §A4 冻结了 `record({..., sessionToolCalls})` 这个**参数名**，
 * 但没有冻结 `sessionToolCalls` 里每个元素的字段形状（docs/SPEC.md §3.3 只说"在会话的 tool/call
 * （name=bash/pwsh）里找 command 包含该 cmd 的记录，并要求其对应 tool/result 的退出码/输出哈希一致"）。
 * 因此下面的样例记录同时提供 `name` / `command` / `args.command` / `exitCode` / `outputSha256`
 * 以及 `result`、`toolResult` 两种嵌套形态，覆盖合理的读取方式。
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
import { createClaims } from '../lib/claims.js';
import { createLedger } from '../lib/ledger.js';

const ROOT = makeTmpDir('perse-proof-claims-');
process.env.PERSE_PROOF_HOME = ROOT;
after(() => removeTmpDir(ROOT));

function setup(overrides = {}) {
  const { config } = resolveConfig(overrides);
  const ctx = createMockCtx();
  const store = createStore({ rootDir: ROOT, logger: ctx.logger });
  const claims = createClaims({ store, config, logger: ctx.logger });
  // 同一个 store 上的 ledger：用来写"真实发生过的工具调用"记录（含退出码来源），
  // 再让 claims 从 store 里读回同一批记录做交叉核对（这才是真实链路）。
  const ledger = createLedger({ store, config, logger: ctx.logger });
  return { config, ctx, store, claims, ledger };
}

function bashCall(command, { exitCode = 0, outputSha256 } = {}) {
  const output = outputSha256 ?? sha256(`${command}:output`);
  const result = { isError: false, exitCode, outputSha256: output };
  return {
    name: 'bash',
    command,
    args: { command },
    arguments: { command },
    exitCode,
    outputSha256: output,
    result,
    toolResult: result,
  };
}

/**
 * 只有命令文本的记录：**读不到**退出码、也没有输出摘要
 * （用于「声明了退出码 / 摘要，但会话记录里读不到该值」这一族用例）。
 */
function bareCall(command) {
  return { name: 'bash', command, args: { command }, arguments: { command } };
}

/**
 * docs/SPEC.md §3.3 的要求是「**拒绝记为 verified**」——两种合法实现都接受：
 *   (a) 直接拒绝（抛错，或返回 `{ok:false, errors:[...]}`）；
 *   (b) 降级成 partial / unverified。
 * 唯一不允许的是"被当作 verified 收下"。
 */
function notAcceptedAsVerified(outcome) {
  if (outcome.threw) return true;
  const r = outcome.result ?? {};
  if (r.ok === false) return true;
  return r.level !== 'verified';
}

test('T7 claim 文件证据: sha 不符 ⇒ 报错且不写入（含实际值）', async () => {
  const { claims } = setup();
  const sessionId = 'session-t7';
  const file = writeTmpFile(ROOT, 'evidence/claim.txt', 'payload');
  const actual = sha256('payload');

  const bad = await attempt(() =>
    claims.record({
      sessionId,
      claim: '已完成改造',
      level: 'verified',
      scope: 'x',
      evidence: [{ kind: 'file', path: file, sha256: '0'.repeat(64) }],
    }),
  );
  assert.ok(failed(bad), 'sha 不符必须被拒');
  assert.match(failText(bad), /sha|摘要|哈希/i, `错误信息应给出 sha 线索，实际：${failText(bad)}`);
  assert.ok(failText(bad).includes(actual), `错误信息应给出实际 sha（${actual}），实际：${failText(bad)}`);

  assert.equal((await claims.list(sessionId)).length, 0, '被拒的 claim 不得写入');
  assert.equal(await claims.hasVerified(sessionId), false, '被拒的 claim 不得让会话变成"已验证"');
});

test('T7 claim 文件证据: sha 相符 ⇒ 记为 verified；纯 manual 证据不得 verified', async () => {
  const { claims } = setup();
  const sessionId = 'session-t7b';
  const file = writeTmpFile(ROOT, 'evidence/claim-ok.txt', 'payload');

  const ok = await attempt(() =>
    claims.record({
      sessionId,
      claim: '已完成改造',
      level: 'verified',
      scope: 'x',
      evidence: [{ kind: 'file', path: file, sha256: sha256('payload') }],
    }),
  );
  assert.equal(failed(ok), false, `正确 sha 应被接受，实际：${failText(ok)}`);
  assert.equal(ok.result?.level, 'verified', `level 应为 verified，实际 ${JSON.stringify(ok.result)}`);
  const checked = ok.result?.checked ?? [];
  assert.equal(checked.length, 1, `应记录 1 条核对结果，实际 ${JSON.stringify(checked)}`);
  assert.equal(checked[0].kind, 'file');
  assert.equal(checked[0].ok, true);
  assert.equal(await claims.hasVerified(sessionId), true);

  const manualOnly = await attempt(() =>
    claims.record({
      sessionId: 'session-t7c',
      claim: '看起来没问题',
      level: 'verified',
      evidence: [{ kind: 'manual', note: '我确认过了' }],
    }),
  );
  assert.ok(failed(manualOnly), 'manual 证据不得支撑 verified（docs/SPEC.md §2）');
});

test('T8 claim 命令证据: 会话里没有对应 bash 记录 ⇒ 拒绝 verified', async () => {
  const { claims } = setup();
  const sessionId = 'session-t8-negative';

  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0, outputSha256: sha256('npm test:output') }],
      sessionToolCalls: [],
    }),
  );
  assert.ok(
    notAcceptedAsVerified(res),
    `无对应记录不得记为 verified，实际 ${JSON.stringify(res.result ?? res.text)}`,
  );
  assert.equal(await claims.hasVerified(sessionId), false, '无对应记录不得让会话变成"已验证"');
  const listed = await claims.list(sessionId);
  assert.equal(
    listed.filter((c) => c?.level === 'verified').length,
    0,
    `不得留下 verified 记录，实际 ${JSON.stringify(listed)}`,
  );

  // 有记录但输出哈希不一致 ⇒ 同样不得 verified
  const mismatch = await attempt(() =>
    claims.record({
      sessionId: 'session-t8-mismatch',
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0, outputSha256: sha256('别的输出') }],
      sessionToolCalls: [bashCall('npm test')],
    }),
  );
  assert.ok(
    notAcceptedAsVerified(mismatch),
    `输出哈希不一致不得记为 verified，实际 ${JSON.stringify(mismatch.result ?? mismatch.text)}`,
  );
  assert.equal(await claims.hasVerified('session-t8-mismatch'), false);
});

test('T8 claim 命令证据: 有真实 bash 记录且退出码/输出哈希一致 ⇒ 通过', async () => {
  const { claims, store } = setup();
  const sessionId = 'session-t8-positive';
  const call = bashCall('npm test', { exitCode: 0 });
  const evidence = [{ kind: 'command', cmd: 'npm test', exitCode: 0, outputSha256: call.outputSha256 }];

  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试全绿',
      level: 'verified',
      evidence,
      sessionToolCalls: [call],
    }),
  );
  assert.equal(failed(res), false, `与真实记录一致应被接受，实际：${failText(res)}`);
  assert.equal(res.result?.level, 'verified', `level 应为 verified，实际 ${JSON.stringify(res.result)}`);
  assert.equal(res.result?.checked?.[0]?.kind, 'command');
  assert.equal(res.result?.checked?.[0]?.ok, true);
  assert.equal(await claims.hasVerified(sessionId), true);

  const list = await claims.list(sessionId);
  assert.equal(list.length, 1, `claims() 应列出 1 条，实际 ${list.length}`);
  assert.equal(list[0].level, 'verified');

  const records = await store.read(sessionId);
  assert.ok(
    records.some((r) => r.type === 'claim' && r.data?.level === 'verified'),
    'store 应落一条 claim 记录',
  );
});

// ————————————————————————————————————————————————————————————————
// T8 家族（收紧后的命令证据规则）：
//   声明了 exitCode / outputSha256 而会话记录里读不到该值 ⇒ 默认拒绝；
//   只有 claims.strictCommandEvidence:false 才允许"按命令文本匹配通过"并附 notes；
//   读到但值不一致 ⇒ 拒绝；找不到记录 ⇒ 默认拒、allowUnmatchedCommands:true 才降级 partial；
//   返回语义：ok:false ⇒ level 必须是 'unverified'，调用方声明的级别放 declaredLevel。
// ————————————————————————————————————————————————————————————————

test('T8d 声明 exitCode 而记录读不到 ⇒ 拒绝（level=unverified，declaredLevel=verified）', async () => {
  const { claims } = setup();
  const sessionId = 'session-t8d';
  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
      sessionToolCalls: [bareCall('npm test')],
    }),
  );
  assert.equal(failed(res), true, `声明了退出码却读不到，必须拒绝，实际 ${JSON.stringify(res.result ?? res.text)}`);
  assert.equal(
    res.result?.level,
    'unverified',
    `ok:false 时 level 必须是 'unverified'，实际 ${JSON.stringify(res.result?.level)}`,
  );
  assert.equal(
    res.result?.declaredLevel,
    'verified',
    `调用方声明的级别应放在 declaredLevel，实际 ${JSON.stringify(res.result?.declaredLevel)}`,
  );
  assert.match(
    failText(res),
    /strictCommandEvidence/,
    `错误文案应提示可用 claims.strictCommandEvidence:false 显式放宽，实际：${failText(res)}`,
  );
  assert.equal(await claims.hasVerified(sessionId), false, '被拒的 claim 不得让会话变成"已验证"');
  assert.equal((await claims.list(sessionId)).length, 0, '被拒的 claim 不得写入');
});

test('T8e 声明 exitCode=0 且记录也是 0 ⇒ 通过（level=verified）', async () => {
  const { claims } = setup();
  const sessionId = 'session-t8e';
  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
      sessionToolCalls: [{ name: 'bash', command: 'npm test', exitCode: 0 }],
    }),
  );
  assert.equal(failed(res), false, `值一致应通过，实际：${failText(res)}`);
  assert.equal(res.result?.level, 'verified', `level 应为 verified，实际 ${JSON.stringify(res.result)}`);
  assert.equal(res.result?.checked?.[0]?.ok, true, '核对结果应为 ok');
  assert.equal(await claims.hasVerified(sessionId), true);
});

test('T8f strictCommandEvidence:false + 记录读不到退出码 ⇒ 通过且 notes 说明原因', async () => {
  const { claims } = setup({ claims: { strictCommandEvidence: false } });
  const sessionId = 'session-t8f';
  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
      sessionToolCalls: [bareCall('npm test')],
    }),
  );
  assert.equal(failed(res), false, `显式放宽后应通过，实际：${failText(res)}`);
  assert.equal(res.result?.level, 'verified', `放宽后 level 应为 verified，实际 ${JSON.stringify(res.result?.level)}`);
  const notes = (res.result?.notes ?? []).join(' | ');
  assert.match(notes, /读不到退出码/, `notes 应说明读不到退出码，实际：${JSON.stringify(res.result?.notes)}`);
});

test('T8g 声明 outputSha256 而记录没有摘要 ⇒ 拒绝', async () => {
  const { claims } = setup();
  const sessionId = 'session-t8g';
  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', outputSha256: 'a'.repeat(64) }],
      sessionToolCalls: [{ name: 'bash', command: 'npm test', exitCode: 0 }],
    }),
  );
  assert.equal(failed(res), true, `声明了摘要却读不到，必须拒绝，实际 ${JSON.stringify(res.result ?? res.text)}`);
  assert.equal(res.result?.level, 'unverified', `ok:false 时 level 必须是 'unverified'，实际 ${JSON.stringify(res.result?.level)}`);
  assert.equal(res.result?.declaredLevel, 'verified');
  assert.equal(await claims.hasVerified(sessionId), false);
});

test('T8h 无执行记录：默认拒；allowUnmatchedCommands:true 才降级 partial', async () => {
  const strict = setup();
  const rejected = await attempt(() =>
    strict.claims.record({
      sessionId: 'session-t8h-strict',
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
      sessionToolCalls: [],
    }),
  );
  assert.equal(failed(rejected), true, `无记录 + 默认严格 ⇒ 必须拒绝，实际 ${JSON.stringify(rejected.result ?? rejected.text)}`);
  assert.equal(rejected.result?.level, 'unverified');
  assert.equal(rejected.result?.declaredLevel, 'verified');
  assert.equal(await strict.claims.hasVerified('session-t8h-strict'), false);

  const lenient = setup({ claims: { allowUnmatchedCommands: true } });
  const downgraded = await attempt(() =>
    lenient.claims.record({
      sessionId: 'session-t8h-lenient',
      claim: '测试全绿',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
      sessionToolCalls: [],
    }),
  );
  assert.equal(failed(downgraded), false, `allowUnmatchedCommands:true ⇒ 应降级收下，实际：${failText(downgraded)}`);
  assert.equal(downgraded.result?.level, 'partial', `应降级为 partial，实际 ${JSON.stringify(downgraded.result?.level)}`);
  assert.equal(await lenient.claims.hasVerified('session-t8h-lenient'), false, '降级为 partial 不等于已验证');
});

test('T8i 返回语义：任何 ok:false 都不得把 level 写回调用方声明的 verified', async () => {
  const { claims } = setup();
  const cases = [
    { label: '读不到退出码', entry: bareCall('npm test'), evidence: { kind: 'command', cmd: 'npm test', exitCode: 0 } },
    { label: '输出摘要不一致', entry: bashCall('npm test'), evidence: { kind: 'command', cmd: 'npm test', outputSha256: 'b'.repeat(64) } },
    { label: '没有执行记录', entry: null, evidence: { kind: 'command', cmd: 'npm test', exitCode: 0 } },
  ];
  for (const item of cases) {
    const outcome = await attempt(() =>
      claims.record({
        sessionId: `session-t8i-${item.label}`,
        claim: `情形：${item.label}`,
        level: 'verified',
        evidence: [item.evidence],
        sessionToolCalls: item.entry === null ? [] : [item.entry],
      }),
    );
    assert.equal(outcome.result?.ok, false, `${item.label} 应返回 ok:false，实际 ${JSON.stringify(outcome.result)}`);
    assert.equal(
      outcome.result?.level,
      'unverified',
      `${item.label}：ok:false 时 level 必须是 'unverified'，实际 ${JSON.stringify(outcome.result?.level)}`,
    );
    assert.equal(
      outcome.result?.declaredLevel,
      'verified',
      `${item.label}：应把声明的级别放进 declaredLevel，实际 ${JSON.stringify(outcome.result?.declaredLevel)}`,
    );
  }
});

// ————————————————————————————————————————————————————————————————
// T8 家族（退出码来源：'reported' / 'inferred-ok' / 'unknown'）：
//   记录由 lib/ledger.js 的 noteToolCall 写进同一个 store，claims 再从 store 读回同一批
//   记录核对 —— 走的是真实链路，而不是调用方自己编一条 sessionToolCalls。
//   inferred-ok 只支撑「声明 exitCode === 0」，且 notes 必须写明"没有失败标记、证据强度弱"。
// ————————————————————————————————————————————————————————————————

const NO_MARK = { isError: false }; // 没有任何退出码标记，但明确不是失败
const FAILED_MARK = { isError: true }; // 明确失败，且没有退出码标记
const EXPLICIT_ZERO = { content: [{ type: 'text', text: 'done\n[exit code: 0]' }] };

test('T8k inferred-ok（isError:false 无标记）+ 声明 exitCode:0 ⇒ 通过且 notes 说明推断依据', async () => {
  const { claims, ledger } = setup();
  const sessionId = 'session-t8k';
  await ledger.noteToolCall({ sessionId, name: 'bash', args: { command: 'npm test' }, toolResult: NO_MARK });

  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试通过',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
    }),
  );
  assert.equal(failed(res), false, `inferred-ok 应支撑 exitCode 0 的声明，实际：${failText(res)}`);
  assert.equal(res.result?.level, 'verified', `level 应为 verified，实际 ${JSON.stringify(res.result?.level)}`);
  const notes = (res.result?.notes ?? []).join(' | ');
  assert.match(notes, /没有失败标记/, `notes 必须写明"没有失败标记"的推断依据，实际：${JSON.stringify(res.result?.notes)}`);
  assert.match(notes, /弱于显式退出码/, `notes 必须说明证据强度弱于显式退出码，实际：${notes}`);
});

test('T8l inferred-ok + 声明 exitCode:1 ⇒ 拒绝（level=unverified）', async () => {
  const { claims, ledger } = setup();
  const sessionId = 'session-t8l';
  await ledger.noteToolCall({ sessionId, name: 'bash', args: { command: 'npm test' }, toolResult: NO_MARK });

  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试失败了一条',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 1 }],
    }),
  );
  assert.equal(failed(res), true, `推断的成功撑不起非 0 声明，必须拒绝，实际 ${JSON.stringify(res.result ?? res.text)}`);
  assert.equal(res.result?.level, 'unverified', `ok:false 时 level 必须是 unverified，实际 ${JSON.stringify(res.result?.level)}`);
  assert.equal(res.result?.declaredLevel, 'verified');
  assert.equal(await claims.hasVerified(sessionId), false);
});

test('T8m isError:true 且无标记 + 声明 exitCode:0 ⇒ 拒绝', async () => {
  const { claims, ledger } = setup();
  const sessionId = 'session-t8m';
  await ledger.noteToolCall({ sessionId, name: 'bash', args: { command: 'npm test' }, toolResult: FAILED_MARK });

  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试通过',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
    }),
  );
  assert.equal(failed(res), true, `明确失败的记录不得支撑 exitCode 0 声明，实际 ${JSON.stringify(res.result ?? res.text)}`);
  assert.equal(res.result?.level, 'unverified');
  assert.equal(res.result?.declaredLevel, 'verified');
});

test('T8n 显式 [exit code: 0] 标记 ⇒ 来源为 reported，声明 exitCode:0 通过', async () => {
  const { claims, ledger, store } = setup();
  const sessionId = 'session-t8n';
  await ledger.noteToolCall({ sessionId, name: 'bash', args: { command: 'npm test' }, toolResult: EXPLICIT_ZERO });

  const records = await store.read(sessionId);
  const call = records.filter((r) => r.type === 'toolcall').at(-1);
  assert.equal(call?.data?.exitCodeSource, 'reported', `显式标记应记为 reported，实际 ${JSON.stringify(call?.data?.exitCodeSource)}`);
  assert.equal(call?.data?.exitCode, 0);

  const res = await attempt(() =>
    claims.record({
      sessionId,
      claim: '测试通过',
      level: 'verified',
      evidence: [{ kind: 'command', cmd: 'npm test', exitCode: 0 }],
    }),
  );
  assert.equal(failed(res), false, `显式退出码一致应通过，实际：${failText(res)}`);
  assert.equal(res.result?.level, 'verified');
  const notes = (res.result?.notes ?? []).join(' | ');
  assert.doesNotMatch(notes, /没有失败标记/, `显式退出码不该出现推断说明，实际：${notes}`);
});
