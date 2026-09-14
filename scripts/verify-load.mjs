#!/usr/bin/env node
/**
 * perse-proof 影子模式加载验证（**绝不碰 3080 / 绝不碰真实 ~/.dsh**）。
 *
 *   node scripts/verify-load.mjs --dry            # 只打印将要执行的命令，什么都不做
 *   node scripts/verify-load.mjs                  # 全流程（npm pack → dsh plugin add → 启动 → 断言 → 清理）
 *   node scripts/verify-load.mjs --no-install     # 跳过 npm pack/add，直接在影子 profile 的 cordis.patch.yml 插一行
 *   node scripts/verify-load.mjs --port 3199 --keep
 *
 * 隔离：DSH_HOME = /tmp/perse-proof-verify-<pid>/home，PERSE_PROOF_HOME = /tmp/perse-proof-verify-<pid>/proof，
 * 端口 ≥ 3199（传 <3199 或 3080 直接拒绝执行）。
 *
 * 断言：
 *   1. A6 自动挂载：`dsh plugin --profile web add <tgz>` 后 dsh.profile.bundles 出现 perse-proof
 *   2. 组合树：`dsh --profile web --dump-config` 的输出里有 perse-proof 这一行
 *   3. 真启动：隔离 DSH_HOME 下 `dsh web --port <≥3199> --no-open` 能起来（HTTP 有响应，且未被 app-boot 审计拒绝）
 *   4. 工具注册：把 lib/index.js 直接 import 进假 ctx 跑 apply()，9 个工具名全部注册（API-NOTES §11.3：
 *      HTTP 面没有"列全局工具"的 REST 路由，故用进程内注册作为确定性证据）
 *   5. 清理：kill 进程、确认端口释放
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createMockCtx, TOOL_NAMES } from '../test/mock-ctx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------------- args ----------------
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

if (hasFlag('--help') || hasFlag('-h')) {
  console.log('用法：node scripts/verify-load.mjs [--dry] [--no-install] [--port 3199] [--keep] [--timeout-ms 45000]');
  process.exit(0);
}

const DRY = hasFlag('--dry');
const INSTALL = !hasFlag('--no-install');
const KEEP = hasFlag('--keep');
const REQUESTED_PORT = Number(argValue('--port', '3199'));
const BOOT_TIMEOUT_MS = Number(argValue('--timeout-ms', '45000'));

if (!Number.isInteger(REQUESTED_PORT) || REQUESTED_PORT < 3199) {
  console.error(
    `拒绝执行：--port 必须 ≥ 3199（本机真实 GUI 占用 3080，绝不允许触碰）。收到：${argValue('--port', '(默认 3199)')}`,
  );
  process.exit(2);
}

const DSH_BIN = process.env.DSH_BIN ?? 'dsh';
const PNPM = process.env.PNPM_BIN ?? 'pnpm';

// ---------------- 输出/断言 ----------------
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const plan = [];
const sh = (cmd, args) => [cmd, ...args].map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ');
const planCmd = (cmd, args, env = {}) => {
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${/[\s"']/.test(v) ? JSON.stringify(v) : v}`)
    .join(' ');
  const line = `${envPrefix ? `${envPrefix} ` : ''}${sh(cmd, args)}`;
  plan.push(line);
  if (DRY) console.log(`$ ${line}`);
  return line;
};

function run(cmd, args, { env = {}, cwd = ROOT, input } = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    input,
    env: { ...process.env, ...env },
  });
}

// ---------------- 影子目录 ----------------
// dry-run 下**不创建任何目录**（只打印命令），避免留下一地临时目录。
const SHADOW = DRY ? '/tmp/perse-proof-verify-<dry-run>' : fs.mkdtempSync(path.join(os.tmpdir(), 'perse-proof-verify-'));
const SHADOW_HOME = path.join(SHADOW, 'home');
const SHADOW_PROOF = path.join(SHADOW, 'proof');
const PDIR = path.join(SHADOW_HOME, 'profiles', 'web');
const BOOT_LOG = path.join(SHADOW, 'boot.log');
const PACK_DIR = path.join(SHADOW, 'pack');
const OVERLAY = path.join(SHADOW, 'perse-proof-overlay.yml');
const CHILD_ENV = { DSH_HOME: SHADOW_HOME, PERSE_PROOF_HOME: SHADOW_PROOF };

console.log('perse-proof · 影子模式加载验证');
console.log(`  隔离 DSH_HOME      = ${SHADOW_HOME}`);
console.log(`  隔离 PROOF_HOME    = ${SHADOW_PROOF}`);
console.log(`  端口                ≥ ${REQUESTED_PORT}（真实 GUI 3080 不会被触碰）`);
console.log(`  dsh                 ${DSH_BIN}`);
console.log(`  模式                ${DRY ? 'dry-run（只打印命令）' : INSTALL ? 'install（npm pack + dsh plugin add）' : 'no-install（直接插 patch 行）'}`);
console.log('');

if (!DRY) {
  fs.mkdirSync(SHADOW_HOME, { recursive: true });
  fs.mkdirSync(SHADOW_PROOF, { recursive: true });
  fs.mkdirSync(PACK_DIR, { recursive: true });
}

// ---------------- 前置检查 ----------------
const missing = [];
for (const rel of ['package.json', 'lib/index.js', 'cordis.patch.yml']) {
  if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
}

// ---------------- 端口 ----------------
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let p = start; p < start + 40; p += 1) {
    if (p === 3080) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(p)) return p;
  }
  throw new Error(`在 ${start}..${start + 39} 里找不到空闲端口`);
}

function portPids(port) {
  const run2 = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return (run2.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function waitPortReleased(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return portFree(port);
}

function httpStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 主流程 ----------------
let child;
let port;

async function main() {
  if (missing.length > 0) {
    check('前置文件齐全（package.json / lib/index.js / cordis.patch.yml）', false, `缺少 ${missing.join(', ')}`);
    console.log('\n实现尚未落地：不启动任何进程。');
    return;
  }
  check('前置文件齐全（package.json / lib/index.js / cordis.patch.yml）', true);

  // 0) dsh 可用
  const dshProbe = spawnSync(DSH_BIN, ['--version'], { encoding: 'utf8' });
  if (DRY) {
    planCmd(DSH_BIN, ['--version']);
  } else if (dshProbe.error || dshProbe.status !== 0) {
    check(`${DSH_BIN} 可用`, false, String(dshProbe.error?.message ?? dshProbe.stderr ?? '').trim());
    return;
  } else {
    check(`${DSH_BIN} 可用`, true, (dshProbe.stdout ?? '').trim());
  }

  // 1) npm pack
  let tgz = null;
  if (INSTALL) {
    if (!DRY) {
      const packed = run('npm', ['pack', '--pack-destination', PACK_DIR, '--json']);
      if (packed.status === 0) {
        try {
          const parsed = JSON.parse((packed.stdout ?? '').slice((packed.stdout ?? '').indexOf('[')));
          tgz = path.join(PACK_DIR, parsed[0].filename);
        } catch {
          tgz = null;
        }
      }
      if (!tgz || !fs.existsSync(tgz)) {
        check('npm pack 产出 tgz', false, (packed.stderr ?? '').trim().slice(0, 300));
        return;
      }
      check('npm pack 产出 tgz', true, path.basename(tgz));
    } else {
      planCmd('npm', ['pack', '--pack-destination', PACK_DIR, '--json']);
      tgz = path.join(PACK_DIR, '<pkg>-<version>.tgz');
    }
  }

  // 2) 初始化隔离 profile
  const initArgs = ['--profile', 'web', '--dump-config'];
  planCmd(DSH_BIN, initArgs, CHILD_ENV);
  if (!DRY) {
    const init = run(DSH_BIN, initArgs, { env: CHILD_ENV, cwd: SHADOW });
    if (init.status !== 0) {
      check('隔离 profile 初始化（--dump-config）', false, (init.stderr ?? '').trim().slice(0, 300));
      return;
    }
    check('隔离 profile 初始化（--dump-config）', true, `profiles/web 就绪：${fs.existsSync(PDIR)}`);
    if (!fs.existsSync(PDIR)) {
      check('profile 目录存在', false, PDIR);
      return;
    }
  }

  // 3) 安装（A6 自动挂载路径）
  let autoMountOk = false;
  if (INSTALL) {
    const addArgs = ['plugin', '--profile', 'web', 'add', tgz];
    planCmd(DSH_BIN, addArgs, CHILD_ENV);
    if (!DRY) {
      const pnpmProbe = spawnSync(PNPM, ['--version'], { encoding: 'utf8' });
      if (pnpmProbe.error) {
        check('pnpm 可用（dsh plugin 是 pnpm 转发器）', false, 'PATH 上没有 pnpm');
      } else {
        const added = run(DSH_BIN, addArgs, { env: CHILD_ENV, cwd: SHADOW });
        const addOut = `${added.stdout ?? ''}${added.stderr ?? ''}`;
        const bundleWarning = /declares no dsh\.bundle/.test(addOut);
        const pkgPath = path.join(PDIR, 'package.json');
        let bundles = [];
        try {
          bundles = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh?.profile?.bundles ?? [];
        } catch {
          bundles = [];
        }
        autoMountOk = added.status === 0 && !bundleWarning && bundles.includes('perse-proof');
        check(
          'A6 自动挂载：dsh plugin add 后 dsh.profile.bundles 含 perse-proof',
          autoMountOk,
          autoMountOk
            ? `bundles=${JSON.stringify(bundles)}`
            : `exit=${added.status} warning=${bundleWarning} bundles=${JSON.stringify(bundles)}`,
        );
        if (!autoMountOk) {
          console.log('      （回退到手工插 patch 行，仅限影子 profile；A6 结论仍为 FAIL）');
        }
      }
    }
  }

  // 4) 组合树里必须有 perse-proof
  const writeInsertRow = () => {
    const patchPath = path.join(PDIR, 'cordis.patch.yml');
    const existing = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
    const kept = existing
      .split('\n')
      .filter((line) => line.trim() !== '' && line.trim() !== '[]' && line.trim() !== '---');
    const block = ['# 影子验证专用（隔离 DSH_HOME）', '- insert:', '    - id: perse-proof', '      name: perse-proof', '      description: perse-proof shadow load check'];
    fs.writeFileSync(patchPath, `${[...kept, ...block].join('\n')}\n`);
    fs.writeFileSync(OVERLAY, `${block.join('\n')}\n`);
  };

  if (!DRY) {
    const needsFallback = !INSTALL || !autoMountOk;
    if (needsFallback) {
      writeInsertRow();
      planCmd('patch <shadow profile>/cordis.patch.yml', ['+ insert perse-proof']);
    }
  } else if (!INSTALL) {
    planCmd('patch <shadow profile>/cordis.patch.yml', ['+ insert perse-proof']);
  }

  const dumpArgs = ['--profile', 'web', '--dump-config'];
  planCmd(DSH_BIN, dumpArgs, CHILD_ENV);
  if (!DRY) {
    let dump = run(DSH_BIN, dumpArgs, { env: CHILD_ENV, cwd: SHADOW });
    let dumpOut = dump.stdout ?? '';
    const combined = `${dump.stdout ?? ''}${dump.stderr ?? ''}`;
    const composeError = /patch: entry .*not found/.test(combined);
    let inTree = /perse-proof/.test(dumpOut);
    check('bundle 层可被组合（无 `patch: entry ... not found`）', !composeError && inTree, composeError ? combined.trim().split('\n')[0].slice(0, 200) : '');
    check('组合树（--dump-config）包含 perse-proof 行', inTree, inTree ? '' : (dump.stderr ?? '').trim().slice(0, 200));

    if (!inTree) {
      // 组合失败（实测：cordis.patch.yml 用了裸 `- id:` 而不是 `- insert:`）。
      // 回退：把 perse-proof 从影子 profile 的 bundles 里拿掉、改为手工 insert 行，
      // 只为拿到"启动 + 工具注册"的证据；bundle 层的结论仍然是 FAIL。
      console.log('      （组合失败 ⇒ 临时回退到"手工 insert 行"路径，只改影子 profile；bundle 层结论仍为 FAIL）');
      try {
        const pkgPath = path.join(PDIR, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const bundles = manifest?.dsh?.profile?.bundles;
        if (Array.isArray(bundles)) {
          manifest.dsh.profile.bundles = bundles.filter((b) => b !== 'perse-proof');
          fs.writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);
        }
      } catch (error) {
        console.log(`      （从 bundles 移除 perse-proof 失败：${error.message}）`);
      }
      writeInsertRow();
      planCmd('patch <shadow profile>/cordis.patch.yml', ['+ insert perse-proof']);
      dump = run(DSH_BIN, dumpArgs, { env: CHILD_ENV, cwd: SHADOW });
      dumpOut = dump.stdout ?? '';
      inTree = /perse-proof/.test(dumpOut);
      check('回退路径：组合树包含 perse-proof 行', inTree, inTree ? '' : (dump.stderr ?? '').trim().slice(0, 200));
      if (!inTree) return;
    }
  }

  // 5) 真启动
  if (DRY) {
    planCmd(DSH_BIN, ['web', '--port', String(REQUESTED_PORT), '--no-open'], CHILD_ENV);
    console.log('\n（dry-run 结束，未启动任何进程）');
    return;
  }
  port = await pickPort(REQUESTED_PORT);
  check(`选定端口 ≥3199 且空闲（≠3080）`, port !== 3080 && port >= 3199, `port=${port}`);

  const out = fs.openSync(BOOT_LOG, 'a');
  const bootArgs = ['web', '--port', String(port), '--no-open'];
  planCmd(DSH_BIN, bootArgs, CHILD_ENV);
  child = spawn(DSH_BIN, bootArgs, {
    cwd: SHADOW,
    env: { ...process.env, ...CHILD_ENV },
    stdio: ['ignore', out, out],
    detached: false,
  });

  let status = 0;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    status = await httpStatus(port);
    if (status !== 0) break;
    if (child.exitCode !== null) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  const bootText = fs.existsSync(BOOT_LOG) ? fs.readFileSync(BOOT_LOG, 'utf8') : '';
  const auditRejected = /did not activate|pending \(waiting for/.test(bootText);
  check('web profile 启动且 HTTP 可达', status !== 0, `HTTP ${status || '(无响应)'}；进程 exitCode=${child.exitCode}`);
  check('未被 app-boot 启动审计拒绝（无 pending/did not activate）', !auditRejected, auditRejected ? '见 boot.log' : '');
  check('启动日志出现 perse-proof 痕迹', /perse-proof/.test(bootText), /perse-proof/.test(bootText) ? '' : 'boot.log 未出现（插件可能没有 console.log，属于可观测性缺陷）');

  // 6) 进程内工具注册证据
  try {
    const mod = await import(`${pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href}?t=${Date.now()}`);
    const ctx = createMockCtx();
    await mod.apply(ctx, {});
    const names = ctx.__spy.tools.map((t) => t.name).sort();
    const expected = [...TOOL_NAMES].sort();
    const same = JSON.stringify(names) === JSON.stringify(expected);
    check('进程内 apply() 注册 9 个工具', same, same ? '' : `实际 ${JSON.stringify(names)}`);
    check('进程内注册契约无问题（execute / 原始 JSON Schema / output）', ctx.__spy.problems.length === 0, JSON.stringify(ctx.__spy.problems));
    check('进程内注册 /proof 命令', ctx.__spy.commands.some((c) => c.name === 'proof'));
  } catch (error) {
    check('进程内 apply() 注册 9 个工具', false, `import/apply 失败：${error.message}`);
  }
}

let cleanupOk = true;
try {
  await main();
} catch (error) {
  check('verify-load 执行', false, String(error?.message ?? error));
} finally {
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGTERM');
    for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(150);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (port !== undefined) {
    const leftover = portPids(port);
    for (const pid of leftover) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    const released = await waitPortReleased(port);
    if (!DRY) check(`端口 ${port} 已释放`, released, released ? '' : `仍被占用：${portPids(port).join(',')}`);
    if (!released) cleanupOk = false;
  }
  if (!DRY) {
    if (KEEP) console.log(`\n（--keep：保留影子目录 ${SHADOW}）`);
    else fs.rmSync(SHADOW, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`verify-load：${results.length - failed.length} 通过 / ${failed.length} 失败${DRY ? '（dry-run，未执行）' : ''}`);
for (const r of failed) console.log(`  FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (!DRY && INSTALL && results.some((r) => /A6 自动挂载/.test(r.name) && !r.ok)) {
  console.log('  !! A6 自动挂载未通过：`dsh plugin add` 没有把 perse-proof 写进 dsh.profile.bundles。');
}
if (DRY) {
  console.log('\n将执行的命令：');
  for (const line of plan) console.log(`  $ ${line}`);
  process.exitCode = 0;
} else {
  if (!cleanupOk) console.log('  !! 清理不完整：端口未释放。');
  process.exitCode = failed.length === 0 ? 0 : 1;
}
