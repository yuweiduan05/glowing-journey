import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 网关端口可用 GATEWAY_PORT 覆盖（与 .env / 环境变量一致），缺省 8081；
// 之前硬编码 127.0.0.1:8081，改 GATEWAY_PORT 会静默打断 dev 代理。
const gatewayPort = process.env.GATEWAY_PORT ?? '8081';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // 生产用同源反代；开发直连 8081（网关已开 CORS）也可以，这里保留代理便于切同源
      '/v1': { target: `http://127.0.0.1:${gatewayPort}`, changeOrigin: true },
      '/health': { target: `http://127.0.0.1:${gatewayPort}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
