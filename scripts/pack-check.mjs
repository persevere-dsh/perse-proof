#!/usr/bin/env node
/**
 * perse-proof 打包产物校验。
 *
 *   node scripts/pack-check.mjs
 *
 * 1) 跑 `npm pack --dry-run --json`（**不**产出 tgz），断言清单包含：
 *      lib/index.js / cordis.patch.yml / README.md / README.zh.md
 * 2) 顺带校验挂载前提（ADDENDUM-A §A6 / SPEC §0）：
 *      package.json 声明 `dsh.bundle.patch = cordis.patch.yml`（否则 `dsh plugin add` 不会自动挂载）
 *      package.json 无 runtime dependencies（纯 JS 零依赖）
 *      cordis.patch.yml 里出现 id/name = perse-proof
 *
 * 任一断言失败 ⇒ 非零退出。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const REQUIRED_FILES = ['lib/index.js', 'cordis.patch.yml', 'README.md', 'README.zh.md'];

const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`无法解析 ${path.relative(ROOT, file)}：${error.message}`);
    return undefined;
  }
}

// ---- 1. npm pack --dry-run --json -----------------------------------------
if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
  fail('package.json 不存在 —— 无法打包（实现尚未落地？）');
} else {
  const run = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.error) {
    fail(`npm pack 无法执行：${run.error.message}`);
  } else if (run.status !== 0) {
    fail(`npm pack --dry-run --json 退出码 ${run.status}\n${(run.stderr ?? '').trim()}`);
  } else {
    const raw = run.stdout ?? '';
    const start = raw.indexOf('[');
    let entries;
    try {
      entries = JSON.parse(start >= 0 ? raw.slice(start) : raw);
    } catch (error) {
      fail(`npm pack 输出不是合法 JSON：${error.message}\n${raw.slice(0, 400)}`);
    }
    if (Array.isArray(entries) && entries.length > 0) {
      const entry = entries[0];
      const packed = (entry.files ?? []).map((f) => f.path);
      console.log(`npm pack --dry-run：${entry.filename} · ${packed.length} 个文件 · ${entry.size ?? '?'} bytes`);
      for (const required of REQUIRED_FILES) {
        if (packed.includes(required)) {
          console.log(`  ok   ${required}`);
        } else {
          fail(`tgz 清单缺少 ${required}`);
          console.log(`  MISS ${required}`);
        }
      }
      const extras = packed.filter((p) => !REQUIRED_FILES.includes(p));
      if (extras.length > 0) note(`额外包含 ${extras.length} 个文件：${extras.slice(0, 8).join(', ')}${extras.length > 8 ? ' …' : ''}`);
      if (packed.some((p) => p.includes('node_modules'))) fail('tgz 清单里出现了 node_modules');
    } else {
      fail('npm pack --dry-run --json 没有返回任何产物');
    }
  }
}

// ---- 2. 挂载前提 ----------------------------------------------------------
const pkg = fs.existsSync(path.join(ROOT, 'package.json'))
  ? readJson(path.join(ROOT, 'package.json'))
  : undefined;

if (pkg) {
  const bundlePatch = pkg.dsh?.bundle?.patch;
  if (bundlePatch === 'cordis.patch.yml') {
    console.log('  ok   package.json: dsh.bundle.patch = cordis.patch.yml（dsh plugin add 会自动挂载）');
  } else {
    fail(`package.json 未声明 dsh.bundle.patch=cordis.patch.yml（实际 ${JSON.stringify(bundlePatch)}）—— A6 要求自动挂载`);
  }
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) {
    console.log('  ok   package.json: 无 runtime dependencies');
  } else {
    fail(`package.json 有 runtime dependencies：${deps.join(', ')}（SPEC §0 要求零依赖）`);
  }
}

const patchPath = path.join(ROOT, 'cordis.patch.yml');
if (fs.existsSync(patchPath)) {
  const patch = fs.readFileSync(patchPath, 'utf8');
  if (/id:\s*perse-proof/.test(patch) && /name:\s*perse-proof/.test(patch)) {
    console.log('  ok   cordis.patch.yml: 含 id/name = perse-proof');
  } else {
    fail('cordis.patch.yml 未同时包含 `id: perse-proof` 与 `name: perse-proof`（A6 的 R-07 静默失败风险）');
  }
  // ⚠️ 关键：bundle 层必须是 **insert**，不能是裸 patch 行。
  // 裸 `- id: perse-proof` 会被 loader 当成"修改已存在的 entry"，组合期直接报
  // `patch: entry "perse-proof" not found`（实测，dsh 0.1.5-rc.1）。
  // 工作样例：perse-updater / perse-cua 的 cordis.patch.yml 都是 `- insert:` 包一行。
  if (/^\s*-\s*insert:\s*$/m.test(patch)) {
    console.log('  ok   cordis.patch.yml: 使用 `- insert:` 包裹（bundle 层插入而非 patch）');
  } else {
    fail(
      'cordis.patch.yml 缺少顶层 `- insert:`（裸 `- id: perse-proof` 会被当成 patch，组合期报 `patch: entry "perse-proof" not found`）',
    );
  }
} else {
  fail('cordis.patch.yml 不存在（A6 要求随包发布该 bundle 层）');
}

if (notes.length > 0) {
  console.log('\n附注：');
  for (const n of notes) console.log(`  - ${n}`);
}

console.log('');
if (failures.length === 0) {
  console.log('pack-check：全部通过');
  process.exitCode = 0;
} else {
  console.log(`pack-check：${failures.length} 项失败`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exitCode = 1;
}
