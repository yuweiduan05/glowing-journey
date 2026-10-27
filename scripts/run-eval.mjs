#!/usr/bin/env node
/** 跨平台运行 RAG 离线评测（复用 run-rag 的 Python 探测逻辑） */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ragDir = path.join(repo, 'services', 'rag');

const python = [
  process.env.RAG_PYTHON,
  path.join(ragDir, '.venv', 'Scripts', 'python.exe'),
  path.join(ragDir, '.venv', 'bin', 'python'),
  'python',
].find((p) => p && (p === 'python' || existsSync(p)));

if (!python) {
  console.error('[eval] 未找到 Python');
  process.exit(1);
}

// 与 run-rag.mjs 相同的前置校验：.pylibs 锁定 cp313，版本不符会给误导性 ImportError
const probe = spawnSync(python, ['-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' });
const versionMatch = probe.status === 0 ? /\((\d+),\s*(\d+)\)/.exec(probe.stdout.trim()) : null;
if (probe.error || probe.status !== 0 || !versionMatch) {
  console.error(`[eval] 无法执行 ${python}：${probe.error?.message ?? probe.stderr?.trim()}`);
  console.error('[eval] 请设置 RAG_PYTHON 指向可用的 Python 3.13 解释器');
  process.exit(1);
}
if (Number(versionMatch[1]) < 3 || (Number(versionMatch[1]) === 3 && Number(versionMatch[2]) < 13)) {
  console.error(
    `[eval] ${python} 是 Python ${versionMatch[1]}.${versionMatch[2]}，` +
      '但 services/rag/.pylibs 的依赖锁定 cp313（需要 3.13）。',
  );
  console.error('[eval] 解法：设置 RAG_PYTHON 指向 3.13，或创建 .venv 后用 pip 安装 requirements.txt');
  process.exit(1);
}

const env = { ...process.env };
const depsDir = path.join(ragDir, '.pylibs');
if (existsSync(depsDir)) {
  env.PYTHONPATH = [depsDir, ragDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

const child = spawn(python, ['scripts/eval.py'], { cwd: ragDir, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
