#!/usr/bin/env node
/**
 * 跨平台启动 RAG 服务。
 *
 * 为什么不直接在 package.json 里写 `python -m uvicorn`：
 * 1) Windows 下 pnpm 默认用 cmd 执行脚本，`PYTHONPATH=.pylibs xxx` 这种前缀写法会失败；
 * 2) 不同机器的依赖安装位置不同（.venv / .pylibs / 全局 site-packages）。
 * 这里统一探测，并用 spawn 传 env，避免 shell 差异。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ragDir = path.join(repo, 'services', 'rag');

const candidates = [
  process.env.RAG_PYTHON,
  path.join(ragDir, '.venv', 'Scripts', 'python.exe'),
  path.join(ragDir, '.venv', 'bin', 'python'),
  'python',
].filter(Boolean);

const python = candidates.find((p) => p === 'python' || existsSync(p));
if (!python) {
  console.error('[run-rag] 未找到 Python，请设置 RAG_PYTHON 或创建 services/rag/.venv');
  process.exit(1);
}

// 版本前置校验：.pylibs 的预编译依赖锁定 cp313。不校验时，用 3.12 启动会拿到
// pydantic_core 的 ImportError——报错信息完全不指向「Python 版本不对」，很难排查。
const probe = spawnSync(python, ['-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(`[run-rag] 无法执行 ${python}：${probe.error?.message ?? probe.stderr?.trim()}`);
  console.error('[run-rag] 请设置 RAG_PYTHON 指向可用的 Python 3.13 解释器');
  process.exit(1);
}
const versionMatch = /\((\d+),\s*(\d+)\)/.exec(probe.stdout.trim());
if (versionMatch && (Number(versionMatch[1]) < 3 || (Number(versionMatch[1]) === 3 && Number(versionMatch[2]) < 13))) {
  console.error(
    `[run-rag] ${python} 是 Python ${versionMatch[1]}.${versionMatch[2]}，` +
      '但 services/rag/.pylibs 的依赖锁定 cp313（需要 3.13）。',
  );
  console.error('[run-rag] 解法：设置 RAG_PYTHON 指向 3.13，或创建 .venv 后用 pip 安装 requirements.txt');
  process.exit(1);
}

const depsDir = path.join(ragDir, '.pylibs');
const env = { ...process.env };
// .pylibs 是 --target 安装目录；.venv 场景无需额外 PYTHONPATH
if (existsSync(depsDir)) {
  env.PYTHONPATH = [depsDir, ragDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

const port = process.env.RAG_PORT ?? '8083';
const child = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port, ...process.argv.slice(2)],
  { cwd: ragDir, env, stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
