// Generates PWA icons into /public from an inline SVG. Run: node scripts/make-icons.mjs
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';

const svg = (pad = 0) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ffb347"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#0b0b10"/>
  <g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
    <path d="M256 92 L392 262 H306 V420 H206 V262 H120 Z" fill="url(#g)"/>
  </g>
</svg>`;

await mkdir('public', { recursive: true });
const png = (name, size, pad) => sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(`public/${name}`);
await Promise.all([
  png('icon-192.png', 192, 0.1),
  png('icon-512.png', 512, 0.1),
  png('icon-512-maskable.png', 512, 0.32),
  png('apple-touch-icon.png', 180, 0.1),
]);
await writeFile('public/favicon.svg', svg(0.1));
console.log('icons written');
