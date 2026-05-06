import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    base: './', // relative paths for JCEF file:// loading
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        sourcemap: false,
        minify: 'esbuild',
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['react', 'react-dom'],
                    markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight'],
                },
            },
        },
    },
});