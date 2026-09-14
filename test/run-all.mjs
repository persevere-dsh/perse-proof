#!/usr/bin/env node
/**
 * perse-proof 测试总入口：**顺序**执行全部 test/*.test.mjs，打印 T1–T14 逐条结论与汇总。
 * 任一用例失败 / 任一测试文件缺失 ⇒ 进程以非零码退出。
 *
 *   node test/run-all.mjs            # 全部
 *   node test/run-all.mjs T1 T2      # 只跑编号匹配的用例（便于定位）
 *
 * 环境：只用 node 内置模块；测试自身写 os.tmpdir() 下的临时目录（PERSE_PROOF_HOME 强制隔离）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** docs/SPEC.md §1 冻结的测试文件清单（顺序即执行顺序）。 */
const FILES = [
  'ledger.test.mjs',
  'criteria.test.mjs',
  'claims.test.mjs',
  'gates.test.mjs',
  'budget.test.mjs',
  'config.test.mjs',
];

const T_CASES = Array.from({ length: 14 }, (_, i) => `T${i + 1}`);
const CASE_RE = /^T(\d{1,2})(?!\d)/;

const filters = process.argv.slice(2).filter((a) => /^T\d{1,2}$/.test(a));
const only = filters.length > 0 ? new Set(filters.map((f) => f.toUpperCase())) : null;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'perse-proof-runall-'));
process.on('exit', () => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});

function parseTap(output) {
  const tests = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const ok = m[1] === 'ok';
    const name = m[2].trim();
    let detail = '';
    if (!ok) {
      const block = [];
      for (let j = i + 1; j < lines.length && block.length < 14; j += 1) {
        if (/^(not ok|ok)\s+\d+\s+-/.test(lines[j])) break;
        if (/^# Subtest:/.test(lines[j])) break;
        block.push(lines[j]);
      }
      detail = block.join('\n').trim();
    }
    tests.push({ ok, name, detail });
  }
  return tests;
}

const fileResults = [];
const caseState = new Map(); // Tn -> {pass, fail, missing:boolean, names:[]}

for (const file of FILES) {
  const abs = path.join(HERE, file);
  if (!fs.existsSync(abs)) {
    fileResults.push({ file, missing: true, tests: [], output: '', status: 1 });
    continue;
  }
  const run = spawnSync(process.execPath, ['--test-reporter=tap', abs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, PERSE_PROOF_HOME: home, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' },
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const tests = parseTap(output);
  fileResults.push({ file, missing: false, tests, output, status: run.status ?? 1 });
}

// 汇总 T 编号
for (const result of fileResults) {
  for (const t of result.tests) {
    const m = CASE_RE.exec(t.name);
    if (!m) continue;
    const key = `T${m[1]}`;
    if (!T_CASES.includes(key)) continue;
    if (only && !only.has(key)) continue;
    const state = caseState.get(key) ?? { pass: 0, fail: 0, names: [] };
    if (t.ok) state.pass += 1;
    else {
      state.fail += 1;
      state.names.push(t.name);
    }
    caseState.set(key, state);
  }
}

const passthrough = (line) => process.stdout.write(`${line}\n`);

passthrough('perse-proof · test/run-all.mjs');
passthrough(`node ${process.version} · cwd=${ROOT} · PERSE_PROOF_HOME=${home}`);
passthrough('');

if (!fs.existsSync(path.join(ROOT, 'lib'))) {
  passthrough('!! lib/ 不存在：实现尚未落地，所有用例都会因 import 失败而 FAIL。');
  passthrough('');
}

let failedFiles = 0;
let totalPass = 0;
let totalFail = 0;

for (const result of fileResults) {
  if (result.missing) {
    failedFiles += 1;
    passthrough(`MISSING  ${result.file}  （docs/SPEC.md §1 要求存在）`);
    continue;
  }
  const pass = result.tests.filter((t) => t.ok).length;
  const fail = result.tests.filter((t) => !t.ok).length;
  totalPass += pass;
  totalFail += fail;
  const mark = fail === 0 && result.status === 0 ? 'PASS' : 'FAIL';
  if (mark === 'FAIL') failedFiles += 1;
  passthrough(`${mark.padEnd(5)}  ${result.file}  （${pass} 通过 / ${fail} 失败，exit=${result.status}）`);

  for (const t of result.tests.filter((x) => !x.ok)) {
    passthrough(`       └─ ${t.name}`);
    if (t.detail) {
      for (const line of t.detail.split('\n').slice(0, 10)) passthrough(`          ${line}`);
    }
  }
  if (result.status !== 0 && result.tests.length === 0) {
    // 文件级失败（import 崩了 / 语法错误）——把原始输出前若干行打出来
    passthrough('       └─ 文件级失败（未产生任何用例结果），原始输出：');
    for (const line of result.output.split('\n').slice(0, 20)) {
      if (line.trim() !== '') passthrough(`          ${line}`);
    }
  }
  passthrough('');
}

passthrough('T1–T14 覆盖矩阵');
for (const key of T_CASES) {
  if (only && !only.has(key)) continue;
  const state = caseState.get(key);
  if (!state) {
    passthrough(`  ${key.padEnd(4)} NOT-RUN   没有任何用例覆盖（或该文件未能加载）`);
    continue;
  }
  const verdict = state.fail === 0 ? 'PASS' : 'FAIL';
  passthrough(`  ${key.padEnd(4)} ${verdict.padEnd(9)} ${state.pass} 通过 / ${state.fail} 失败`);
  for (const name of state.names) passthrough(`         └─ ${name}`);
}

passthrough('');
passthrough(
  `汇总：${fileResults.length} 个测试文件，${fileResults.length - failedFiles} 全绿 / ${failedFiles} 失败；` +
    `用例 ${totalPass} 通过 / ${totalFail} 失败。`,
);

const missingT = T_CASES.filter((k) => !only || only.has(k)).filter((k) => !caseState.has(k));
if (missingT.length > 0) passthrough(`未覆盖/未执行到结果的编号：${missingT.join(', ')}`);

const ok = failedFiles === 0 && totalFail === 0 && missingT.length === 0;
passthrough(ok ? '结果：全部通过' : '结果：存在失败（退出码 1）');
process.exitCode = ok ? 0 : 1;
