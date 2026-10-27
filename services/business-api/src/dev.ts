/**
 * 演示 profile 入口（`pnpm dev` → business-api 的 dev 脚本走这里）。
 *
 * 故障注入总开关在代码里默认关闭（安全默认，见 `env.ts`）；
 * 演示 / 联调 / e2e 需要 `?chaos=slow|fail|500`，由这个入口显式打开——
 * 「默认关、演示显式开」，避免误部署后一个查询参数打死服务。
 */
process.env.BUSINESS_CHAOS_ENABLED ||= '1';

await import('./server.js');
