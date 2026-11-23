import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves from /<repo>/, so production builds use that base.
// Override with BASE_PATH=/ for Netlify or other root hosting.
export default defineConfig(({ command }) => {
  const base = command === 'build' ? process.env.BASE_PATH ?? '/motivati-scroll/' : '/';
  return {
    base,
    plugins: [
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['apple-touch-icon.png', 'favicon.svg'],
        manifest: {
          name: 'Motivati-scroll',
          short_name: 'Motivate',
          description: 'Only the videos that get you moving, plus a nudge out of your comfort zone.',
          theme_color: '#0b0b10',
          background_color: '#0b0b10',
          display: 'standalone',
          orientation: 'portrait',
          start_url: base,
          scope: base,
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: { globPatterns: ['**/*.{js,css,html,svg,png,json,webmanifest}'] },
      }),
    ],
    server: { host: true, watch: { usePolling: true } },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
