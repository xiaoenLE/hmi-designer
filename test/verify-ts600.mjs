#!/usr/bin/env node
// test/verify-ts600.mjs —— TS600 Modbus TCP 地址模型 / 链路 回归套件
//
// 用法：
//   node test/verify-ts600.mjs            （tools/run-suites.mjs 会自动发现并调用）
//   node test/verify-ts600.mjs [端口]      （端口参数保留兼容，本套件不用）
//
// 实际校验逻辑在 python 自测脚本 test/_ts600_selftest.py（后端维护），
// 本文件只负责：找到解释器 → 启动自测 → 透传输出 → 校验退出码与 OK 标记。
// 约定：自测脚本以 0 退出，且输出里出现独立的 OK 标记（如 "OK" / "ALL OK" / "[OK]"）。
//
// 环境变量：
//   TS600_PYTHON  指定 python 解释器完整路径（优先于内置候选）
//   TS600_TIMEOUT_MS  超时毫秒数（默认 180000）

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELFTEST = join(ROOT, 'test', '_ts600_selftest.py');
const TIMEOUT_MS = Number(process.env.TS600_TIMEOUT_MS || 180000) || 180000;
// run-suites.mjs 会给每个套件传端口号，本套件不需要，忽略即可。
const _ignoredArg = process.argv[2];

const PY_CANDIDATES = [
  process.env.TS600_PYTHON || '',
  'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
  'python',
  'python3',
  'py',
].filter(Boolean);

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? `  —— ${extra}` : ''}`;
  console.log(line);
  return !!cond;
}

// ---------------------------------------------------------------- 找解释器
function probeInterpreter(cmd) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, ['-c', 'import sys;print(sys.version.split()[0])'], {
        cwd: ROOT,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      resolve(code === 0 ? { cmd, version: out.trim() } : null);
    });
  });
}

async function findPython() {
  for (const cmd of PY_CANDIDATES) {
    const hit = await probeInterpreter(cmd);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- 跑自测
function runSelftest(python) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };

    let p;
    try {
      // -v：让自测把每条断言都打出来（含 [ok] 标记），日志更有用
      p = spawn(python, [SELFTEST, '-v'], {
        cwd: ROOT,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      finish({ code: -1, signal: null, out, err, spawnError: String(e && e.message || e) });
      return;
    }

    const timer = setTimeout(() => {
      // 超时：先礼后兵，杀不掉就放弃等待
      try { p.kill(); } catch { /* ignore */ }
      setTimeout(() => {
        try { p.kill('SIGKILL'); } catch { /* ignore */ }
        finish({ code: -9, signal: 'timeout', out, err, timedOut: true });
      }, 2000);
    }, TIMEOUT_MS);

    p.stdout.on('data', (d) => {
      const s = String(d);
      out += s;
      process.stdout.write(s); // 透传，保持实时输出
    });
    p.stderr.on('data', (d) => {
      const s = String(d);
      err += s;
      process.stderr.write(s);
    });
    p.on('error', (e) => {
      finish({ code: -1, signal: null, out, err, spawnError: String(e && e.message || e) });
    });
    p.on('close', (code, signal) => {
      finish({ code, signal, out, err });
    });
  });
}

// ---------------------------------------------------------------- 主流程
async function main() {
  console.log('==== verify-ts600：TS600 Modbus TCP 地址模型回归 ====');
  console.log(`仓库根：${ROOT}`);

  if (!ok('test/_ts600_selftest.py 存在', existsSync(SELFTEST), `缺少 test/_ts600_selftest.py（${SELFTEST}）`)) {
    report();
    return;
  }

  const py = await findPython();
  ok('找到 python 解释器', !!py, `尝试过：${PY_CANDIDATES.join(' / ')}（可用 TS600_PYTHON 指定）`);
  if (!py) {
    report();
    return;
  }
  console.log(`使用 python：${py.cmd}（${py.version}）`);

  console.log('---------------- 运行 test/_ts600_selftest.py ----------------');
  const r = await runSelftest(py.cmd);

  if (r.spawnError) {
    ok('自测脚本能启动', false, r.spawnError);
    report();
    return;
  }
  if (r.timedOut) {
    ok('自测脚本未超时', false, `超过 ${TIMEOUT_MS} ms，已强制结束`);
    report();
    return;
  }
  ok('自测脚本正常结束', r.code === 0, `退出码 ${r.code}${r.signal ? `，信号 ${r.signal}` : ''}`);
  if (r.code !== 0) {
    report();
    return;
  }

  const combined = `${r.out}\n${r.err}`;
  // OK 标记：独立 OK / ALL OK / 每条断言的 [ok] / 中文「全部通过」都算通过标记。
  // （test/_ts600_selftest.py 的约定输出是逐条 "  [ok]   <断言名>" 与末行「TS600 自测：全部通过」）
  const hasOk = /\[ok\]/i.test(combined)
    || /(?:^|[^A-Za-z])OK(?:[^A-Za-z]|$)/m.test(combined)
    || /ALL\s+OK/i.test(combined)
    || /全部通过/.test(combined);
  ok('输出含 OK 标记', hasOk, '自测输出里没看到 OK 标记（约定：逐条 [ok] / ALL OK / 全部通过）');
  ok('自测有实际输出', combined.trim().length > 0, '脚本没有任何输出');

  report();
}

function report() {
  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  console.log('');
  if (failed.length) {
    console.log(`未通过项：${failed.map((r) => r.name).join('；')}`);
  }
  console.log(`==== verify-ts600：${passed}/${results.length} 通过 ====`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL  套件自身异常：${e && e.stack || e}`);
  console.log('==== verify-ts600：0/1 通过 ====');
  process.exit(1);
});
