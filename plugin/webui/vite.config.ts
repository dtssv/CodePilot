import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * Vite always generates `<script type="module">` in the built HTML, even with
 * `format: 'iife'`. JCEF's embedded Chromium cannot load ES modules over
 * `file://` protocol, so we post-process the HTML to:
 *   1. Remove `type="module"` from script tags
 *   2. Remove `crossorigin` attributes (problematic with file://)
 *   3. Remove `<link rel="modulepreload">` tags entirely
 *   4. Move `<script>` tags to end of `<body>` (IIFE executes synchronously;
 *      without `type="module"` the deferred behavior is lost, so React's
 *      createRoot cannot find the #root container if scripts stay in <head>)
 */
function jcefCompat(): Plugin {
    return {
        name: 'jcef-compat',
        enforce: 'post',
        generateBundle(_, bundle) {
            for (const file of Object.values(bundle)) {
                if (file.type === 'asset' && file.fileName === 'index.html') {
                    let html = file.source as string;
                    // Remove modulepreload links
                    html = html.replace(/<link[^>]*rel=["']modulepreload["'][^>]*>\n?/g, '');
                    // Remove type="module" from script tags
                    html = html.replace(/(<script[^>]*)\s+type=["']module["']/g, '$1');
                    // Remove crossorigin attributes
                    html = html.replace(/(<script[^>]*)\s+crossorigin/g, '$1');
                    html = html.replace(/(<link[^>]*)\s+crossorigin/g, '$1');
                    // Move <script> tags from <head> to end of <body>
                    // so they execute after the DOM is ready.
                    const scriptTags: string[] = [];
                    html = html.replace(/<script[^>]*><\/script>\n?/g, (match) => {
                        scriptTags.push(match);
                        return '';
                    });
                    if (scriptTags.length > 0) {
                        html = html.replace('</body>', scriptTags.join('') + '</body>');
                    }
                    file.source = html;
                }
            }
        },
    };
}

export default defineConfig({
    plugins: [react(), jcefCompat()],
    base: './', // relative paths for JCEF file:// loading
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        sourcemap: false,
        minify: 'esbuild',
        rollupOptions: {
            output: {
                // JCEF's embedded Chromium does not support ES modules over file:// protocol.
                // Use IIFE format to ensure scripts load correctly via file:// URLs.
                format: 'iife',
                // IIFE format does not support code splitting; inline everything into a single bundle.
                inlineDynamicImports: true,
                entryFileNames: 'assets/[name].js',
                chunkFileNames: 'assets/[name].js',
                assetFileNames: 'assets/[name].[ext]',
            },
        },
    },
});