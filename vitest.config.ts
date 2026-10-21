import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Day 1 只有纯函数测试，不需要 setupFiles / 全局注入。
    globals: false,
  },
});
