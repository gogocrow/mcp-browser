import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // 同时被 node 服务端和浏览器插件引用，不能带任何一侧的平台假设
  platform: 'neutral',
  sourcemap: true,
});
