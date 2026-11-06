#!/usr/bin/env node
/**
 * 跨平台运行 RAG 单测（unittest + 契约实例校验）。
 *
 * 为什么不直接在文档里写 `PYTHONPATH=.pylibs python -m unittest`：
 * 1) Windows 的 cmd / PowerShell 不支持 `VAR=x cmd` 这种前缀语法，照抄直接失败；
 * 2) `.pylibs` 是 `pip install --target` 的目录，不进 sys.path 就会 ImportError: pydantic。
 * 探测顺序与 run-rag.mjs / run-eval.mjs 保持一致，改动请三处同步。
 *
 * 用法：
 *   pnpm test:rag          # 26 条，正常输出
 *   pnpm test:rag -- -v    # 透传额外参数给 unittest
 */
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
  console.error('[test:rag] 未找到 Python，请设置 RAG_PYTHON 或创建 services/rag/.venv');
  process.exit(1);
}

const probe = spawnSync(python, ['-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' });
const versionMatch = probe.status === 0 ? /\((\d+),\s*(\d+)\)/.exec(probe.stdout.trim()) : null;
if (probe.error || probe.status !== 0 || !versionMatch) {
  console.error(`[test:rag] 无法执行 ${python}：${probe.error?.message ?? probe.stderr?.trim()}`);
  console.error('[test:rag] 请设置 RAG_PYTHON 指向可用的 Python 解释器');
  process.exit(1);
}
if (Number(versionMatch[1]) < 3 || (Number(versionMatch[1]) === 3 && Number(versionMatch[2]) < 13)) {
  console.error(
    `[test:rag] ${python} 是 Python ${versionMatch[1]}.${versionMatch[2]}，` +
      '但 services/rag/.pylibs 的依赖锁定 cp313（需要 3.13）。',
  );
  console.error('[test:rag] 解法：设置 RAG_PYTHON 指向 3.13，或创建 .venv 后用 pip 安装 requirements.txt');
  process.exit(1);
}

const env = { ...process.env };
const depsDir = path.join(ragDir, '.pylibs');
if (existsSync(depsDir)) {
  env.PYTHONPATH = [depsDir, ragDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

const child = spawn(python, ['-m', 'unittest', 'discover', '-s', 'tests', ...process.argv.slice(2)], {
  cwd: ragDir,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
