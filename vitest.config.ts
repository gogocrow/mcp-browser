import { defineConfig } from 'vitest/config';

// 单一根配置而非每包一份：`vitest run -t '<名字>'` 能一次过滤到所有包的用例
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // 桥的日志走 stderr，跑测试时会盖住真正的失败信息
    env: { BRIDGE_LOG: 'off' },
  },
});
