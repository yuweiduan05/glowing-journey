import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 显式固定包内缓存目录：默认临时目录在受限环境 / 多包并发启动时会 EPERM，
    // 导致测试runner报 unhandled error（环境噪声，不是用例失败）。
    cacheDir: './node_modules/.vite',
  },
});
