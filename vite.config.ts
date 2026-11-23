import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The app is served from the root of the home server (server/server.mjs), same origin as /api and /media.
// In dev, Vite proxies those paths to the server (API_TARGET, default http://localhost:5183).
const apiTarget = process.env.API_TARGET ?? 'http://localhost:5183';

export default defineConfig(() => {
  const base = '/';
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
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,json,webmanifest}'],
          // Never answer API or media requests with the cached app shell.
          navigateFallbackDenylist: [/^\/api\//, /^\/media\//],
        },
      }),
    ],
    server: {
      host: true,
      watch: { usePolling: true },
      proxy: { '/api': apiTarget, '/media': apiTarget },
    },
    test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.mjs'] },
  };
});
