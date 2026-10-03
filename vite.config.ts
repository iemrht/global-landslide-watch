import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// 只发布到 GitHub Pages：网址为 https://<用户名>.github.io/<仓库名>/
export default defineConfig(({ command, isPreview }) => {
  const repository = process.env.GITHUB_REPOSITORY?.split('/').at(-1) ?? 'global-landslide-watch';
  return {
    base: command === 'build' || isPreview ? `/${repository}/` : '/',
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(root, 'src') } },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
  };
});
