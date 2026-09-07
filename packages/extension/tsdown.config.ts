import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    background: 'src/background/index.ts',
    popup: 'src/popup/index.ts',
  },
  format: ['esm'],
  platform: 'browser',
  clean: true,
  dts: false,
  sourcemap: true,
  // 插件里没有 node_modules 解析，工作区包和 zod 都必须打进产物
  deps: { alwaysBundle: ['@browser-mcp/shared', 'zod'] },
});
