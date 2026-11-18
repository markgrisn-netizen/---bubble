import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import * as esbuild from 'esbuild';

const extRoot = path.resolve(process.cwd(), 'browser-extension');
const distDir = path.join(extRoot, 'dist');
const iconsDir = path.join(distDir, 'icons');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(iconsDir, { recursive: true });

// Generate crisp PNG icons (16x16, 48x48, 128x128) cleanly with Node zlib (no native deps)
function createPngIcon(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      const border = x < Math.max(1, Math.floor(size / 12)) ||
        x >= width - Math.max(1, Math.floor(size / 12)) ||
        y < Math.max(1, Math.floor(size / 12)) ||
        y >= height - Math.max(1, Math.floor(size / 12));
      const inInnerPanel =
        x > size * 0.24 && x < size * 0.76 && y > size * 0.24 && y < size * 0.76;
      if (border) {
        // #4F46E5 Indigo frame
        raw[px] = 79;
        raw[px + 1] = 70;
        raw[px + 2] = 229;
        raw[px + 3] = 255;
      } else if (inInnerPanel) {
        // White speech-bubble block
        raw[px] = 248;
        raw[px + 1] = 250;
        raw[px + 2] = 252;
        raw[px + 3] = 255;
      } else {
        // Dark slate canvas
        raw[px] = 15;
        raw[px + 1] = 23;
        raw[px + 2] = 42;
        raw[px + 3] = 255;
      }
    }
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), createPngIcon(size));
}

// Write lightweight popup CSS matching the Tailwind classes used in PopupApp.tsx
const popupCss = `
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #020617; color: #f1f5f9; }
.w-\\[410px\\] { width: 410px; }
.min-h-\\[520px\\] { min-height: 520px; }
.bg-slate-950 { background: #020617; }
.bg-slate-900 { background: #0f172a; }
.bg-slate-800 { background: #1e293b; }
.bg-indigo-600 { background: #4f46e5; }
.hover\\:bg-indigo-700:hover { background: #4338ca; }
.bg-indigo-950 { background: #1e1b4b; }
.hover\\:bg-indigo-900:hover { background: #312e81; }
.bg-emerald-950 { background: #022c22; }
.bg-emerald-950\\/60 { background: rgba(2, 44, 34, 0.6); }
.bg-rose-950 { background: #4c0519; }
.bg-rose-950\\/60 { background: rgba(76, 5, 25, 0.6); }
.bg-amber-950\\/60 { background: rgba(69, 26, 3, 0.6); }
.bg-indigo-500 { background: #6366f1; }
.text-slate-100 { color: #f1f5f9; }
.text-slate-200 { color: #e2e8f0; }
.text-slate-300 { color: #cbd5e1; }
.text-slate-400 { color: #94a3b8; }
.text-slate-500 { color: #64748b; }
.text-white { color: #ffffff; }
.text-indigo-100 { color: #e0e7ff; }
.text-indigo-400 { color: #818cf8; }
.text-emerald-300 { color: #6ee7b7; }
.text-emerald-200 { color: #a7f3d0; }
.text-rose-200 { color: #fecdd3; }
.text-rose-300 { color: #fda4af; }
.text-rose-400 { color: #fb7185; }
.text-amber-200 { color: #fde68a; }
.border { border-width: 1px; border-style: solid; }
.border-b { border-bottom-width: 1px; border-bottom-style: solid; }
.border-t { border-top-width: 1px; border-top-style: solid; }
.border-slate-800 { border-color: #1e293b; }
.border-slate-700 { border-color: #334155; }
.border-indigo-700 { border-color: #4338ca; }
.border-emerald-800 { border-color: #065f46; }
.border-rose-800 { border-color: #9f1239; }
.border-amber-700 { border-color: #b45309; }
.rounded { border-radius: 0.25rem; }
.rounded-lg { border-radius: 0.5rem; }
.p-1\\.5 { padding: 0.375rem; }
.p-2 { padding: 0.5rem; }
.p-2\\.5 { padding: 0.625rem; }
.p-3\\.5 { padding: 0.875rem; }
.px-1\\.5 { padding-left: 0.375rem; padding-right: 0.375rem; }
.px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
.py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
.py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
.py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; }
.py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
.py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
.pb-2\\.5 { padding-bottom: 0.625rem; }
.pt-1 { padding-top: 0.25rem; }
.space-y-1 > * + * { margin-top: 0.25rem; }
.space-y-1\\.5 > * + * { margin-top: 0.375rem; }
.space-y-2 > * + * { margin-top: 0.5rem; }
.space-y-3 > * + * { margin-top: 0.75rem; }
.flex { display: flex; }
.flex-1 { flex: 1 1 0%; }
.min-w-0 { min-width: 0; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.grid { display: grid; }
.grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.gap-1 { gap: 0.25rem; }
.gap-1\\.5 { gap: 0.375rem; }
.gap-2 { gap: 0.5rem; }
.w-full { width: 100%; }
.w-9 { width: 2.25rem; }
.h-11 { height: 2.75rem; }
.h-1\\.5 { height: 0.375rem; }
.max-h-40 { max-height: 10rem; }
.overflow-y-auto { overflow-y: auto; }
.overflow-hidden { overflow: hidden; }
.object-cover { object-fit: cover; }
.text-xs { font-size: 0.75rem; line-height: 1rem; }
.text-sm { font-size: 0.875rem; line-height: 1.25rem; }
.text-\\[10px\\] { font-size: 10px; line-height: 1.2; }
.text-\\[11px\\] { font-size: 11px; line-height: 1.35; }
.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.text-center { text-align: center; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leading-relaxed { line-height: 1.5; }
.cursor-pointer { cursor: pointer; }
.disabled\\:opacity-40:disabled { opacity: 0.4; }
.disabled\\:opacity-50:disabled { opacity: 0.5; }
button { font-family: inherit; }
textarea { resize: vertical; }
`;
fs.writeFileSync(path.join(distDir, 'popup.css'), popupCss.trim(), 'utf-8');

await esbuild.build({
  entryPoints: [
    path.join(extRoot, 'src/popup/popup.tsx'),
    path.join(extRoot, 'src/background/serviceWorker.ts'),
    path.join(extRoot, 'src/content/captureContent.ts'),
  ],
  outdir: distDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  entryNames: '[name]',
  jsx: 'automatic',
});

fs.copyFileSync(path.join(extRoot, 'manifest.json'), path.join(distDir, 'manifest.json'));
fs.copyFileSync(path.join(extRoot, 'popup.html'), path.join(distDir, 'popup.html'));

console.log('Built PanelTranslate AI Browser Companion Extension -> browser-extension/dist');
