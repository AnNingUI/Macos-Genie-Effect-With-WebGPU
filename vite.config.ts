import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5201,
    strictPort: true,
    watch: {
      // 编辑器/工具做原子写入时会生成 `.xxx.tmpdir/` 临时目录，
      // Vite 的 fs watcher 尝试 watch 它时可能抛 EBUSY（Windows 上尤其常见），
      // 直接导致 dev server 崩掉。这里显式忽略这类临时产物。
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/node_modules/**',
        '**/dist/**',
      ],
    },
  },
  build: { target: 'esnext' },
});
