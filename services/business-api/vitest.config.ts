import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 同 apps/gateway：固定包内缓存目录，避开系统 Temp 的并发写冲突
    cacheDir: './node_modules/.vite',
  },
});
