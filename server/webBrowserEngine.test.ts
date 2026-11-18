import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import {
  captureTabScreenshotAsPage,
  closeBrowserTab,
  collectTabComicImages,
  createBrowserTab,
  getBrowserCapabilities,
  getBrowserWorkspaceState,
  goBackBrowserTab,
  goForwardBrowserTab,
  importBrowserImagesToStudio,
  interactWithBrowserTab,
  navigateBrowserTab,
  shutdownBrowserEngine,
  updateBrowserPrivacySettings,
} from './webBrowserEngine.ts';
import { importMobileSharePayload } from './mobileShare.ts';
import { getDb, saveDb } from './store.ts';

/**
 * Builds a valid lossless RGBA PNG buffer of exact width x height so Chromium
 * renders authentic full-size comic pages (`naturalWidth >= 400`, `naturalHeight >= 550`).
 */
function buildSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * 4;
  const raw = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + 1 + x * 4;
      raw[idx] = (r + (x % 37)) & 0xff;
      raw[idx + 1] = (g + (y % 53)) & 0xff;
      raw[idx + 2] = b;
      raw[idx + 3] = 255;
    }
  }

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let server: http.Server;
let baseUrl = '';
const createdChapterIds: string[] = [];
const browserWorkspaceFile = path.resolve(process.cwd(), 'data', 'browser_workspace.json');
let originalWorkspaceJson: string | null = null;

before(async () => {
  if (fs.existsSync(browserWorkspaceFile)) {
    originalWorkspaceJson = fs.readFileSync(browserWorkspaceFile, 'utf-8');
  }

  const page1 = buildSolidPng(420, 620, 210, 45, 50);
  const page2 = buildSolidPng(420, 620, 40, 120, 220);
  const page3 = buildSolidPng(420, 620, 30, 175, 95);

  server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/img/p1.png' || url === '/img/p1-dup.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(page1);
      return;
    }
    if (url === '/img/p2.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(page2);
      return;
    }
    if (url === '/img/p3.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(page3);
      return;
    }

    if (url === '/chapter-1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Sentinel Issue #1</title></head>
        <body>
          <h1>Sentinel Comics — Issue #1</h1>
          <img src="/img/p1.png" width="420" height="620" />
          <a href="/chapter-2">Next Chapter</a>
        </body></html>`);
      return;
    }

    if (url === '/chapter-2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Sentinel Issue #2</title></head>
        <body>
          <h1>Sentinel Comics — Issue #2</h1>
          <img src="/img/p2.png" width="420" height="620" />
          <a href="/chapter-1">Previous Chapter</a>
        </body></html>`);
      return;
    }

    if (url === '/lazy-chapter') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Lazy Comic Issue</title></head>
        <body style="margin:0;padding:0;">
          <img src="/img/p1.png" width="420" height="620" style="display:block;margin-bottom:950px;" />
          <img id="lazy1" data-src="/img/p2.png" width="420" height="620" style="display:block;margin-bottom:400px;" />
          <img id="dup1" data-src="/img/p1-dup.png" width="420" height="620" style="display:block;" />
          <script>
            function revealLazy() {
              if (window.scrollY > 400) {
                for (const el of document.querySelectorAll('img[data-src]')) {
                  if (!el.getAttribute('src')) {
                    el.setAttribute('src', el.getAttribute('data-src'));
                  }
                }
              }
            }
            window.addEventListener('scroll', revealLazy);
          </script>
        </body></html>`);
      return;
    }

    if (url === '/login') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (body.includes('user=reader') && body.includes('pass=comic123')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><html><head><title>Member Chapter #9</title></head>
              <body>
                <h1>Unlocked Member Issue #9</h1>
                <img src="/img/p3.png" width="420" height="620" />
              </body></html>`);
          } else {
            res.writeHead(401, { 'Content-Type': 'text/html' });
            res.end('<html><body>Invalid credentials</body></html>');
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Member Login</title></head>
        <body style="margin:0;padding:24px;">
          <form method="POST" action="/login">
            <input id="u" name="user" type="text" placeholder="Username" style="display:block;width:240px;height:36px;margin-bottom:12px;" />
            <input id="p" name="pass" type="password" placeholder="Password" style="display:block;width:240px;height:36px;margin-bottom:12px;" />
            <button id="submitBtn" type="submit" style="width:140px;height:40px;">Sign In</button>
          </form>
        </body></html>`);
      return;
    }

    if (url === '/blocked-403') {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Just a moment...</title></head><body>Verify you are human - HTTP 403</body></html>');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(async () => {
  await shutdownBrowserEngine();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Clean up chapters/pages created during test from db.json and uploads
  if (createdChapterIds.length > 0) {
    const db = getDb();
    const idSet = new Set(createdChapterIds);
    const removedPages = db.pages.filter((p) => idSet.has(p.chapterId));
    for (const pg of removedPages) {
      if (pg.originalImage.startsWith('/uploads/')) {
        const diskPath = path.resolve(process.cwd(), 'data', pg.originalImage.slice(1));
        if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
      }
    }
    db.chapters = db.chapters.filter((c) => !idSet.has(c.id));
    db.pages = db.pages.filter((p) => !idSet.has(p.chapterId));
    saveDb();
  }

  // Restore original browser_workspace.json cleanly
  if (originalWorkspaceJson !== null) {
    fs.writeFileSync(browserWorkspaceFile, originalWorkspaceJson, 'utf-8');
  } else if (fs.existsSync(browserWorkspaceFile)) {
    fs.unlinkSync(browserWorkspaceFile);
  }
});

test('1. getBrowserCapabilities confirms non-iframe Chromium engine and Android module availability', () => {
  const caps = getBrowserCapabilities();
  assert.equal(caps.iframeSupported, false);
  assert.equal(caps.serverChromiumAvailable, true);
  assert.equal(caps.androidModuleAvailable, true);
  assert.equal(caps.shareIntentSupported, true);
});

test('2-3. Internal Browser opens Chapter 1, navigates to Chapter 2, supports Back/Forward, and imports single & multi-page drafts straight to Translator', async () => {
  await updateBrowserPrivacySettings({ privacyMode: 'standard', clearHistory: true });
  const tab = await createBrowserTab({
    url: `${baseUrl}/chapter-1`,
    allowLocalTestServer: true,
  });

  try {
    assert.equal(tab.title, 'Sentinel Issue #1');
    assert.equal(tab.httpStatus, 200);
    assert.equal(tab.discoveredImageCount, 1);
    assert.ok(tab.chapterLinks.some((l) => l.kind === 'next' && l.url.endsWith('/chapter-2')));

    // Navigate to Chapter 2
    const ch2 = await navigateBrowserTab(tab.id, `${baseUrl}/chapter-2`, {
      allowLocalTestServer: true,
    });
    assert.equal(ch2.title, 'Sentinel Issue #2');
    assert.equal(ch2.canGoBack, true);

    // Back & Forward
    const back = await goBackBrowserTab(tab.id);
    assert.equal(back.title, 'Sentinel Issue #1');
    assert.equal(back.canGoForward, true);

    const fwd = await goForwardBrowserTab(tab.id);
    assert.equal(fwd.title, 'Sentinel Issue #2');

    // Collect single page image & import as draft directly without source_fetch
    const collected = await collectTabComicImages(tab.id, { autoScrollLazy: false });
    assert.equal(collected.blockedByProtection, false);
    assert.equal(collected.images.length, 1);
    assert.equal(collected.images[0].width, 420);
    assert.equal(collected.images[0].height, 620);

    const db = getDb();
    const project = db.projects[0];
    assert.ok(project);

    const draft = importBrowserImagesToStudio({
      projectId: project.id,
      chapterTitle: 'Internal Browser Draft Test',
      sourceUrl: ch2.url,
      pages: [collected.images[0]],
    });
    createdChapterIds.push(draft.chapter.id);

    assert.equal(draft.chapter.status, 'draft');
    assert.equal(draft.pages.length, 1);
    assert.ok(draft.pages[0].originalImage.startsWith('/uploads/'));

    // Screenshot fallback captures valid PNG
    const shot = await captureTabScreenshotAsPage(tab.id, 'visible');
    assert.equal(shot.captureSource, 'screenshot_fallback');
    assert.ok(shot.dataUrl.startsWith('data:image/png;base64,'));
  } finally {
    await closeBrowserTab(tab.id);
  }
});

test('4. Manual login wall lets user click/type into fields directly without credential theft', async () => {
  const tab = await createBrowserTab({
    url: `${baseUrl}/login`,
    allowLocalTestServer: true,
  });

  try {
    assert.equal(tab.protectionStatus, 'login_wall');

    // Click username input (x=120, y=42), type username
    await interactWithBrowserTab(tab.id, { type: 'click', x: 120, y: 42 });
    await interactWithBrowserTab(tab.id, { type: 'type', text: 'reader' });

    // Click password input (x=120, y=90), type password + Enter to submit form
    await interactWithBrowserTab(tab.id, { type: 'click', x: 120, y: 90 });
    const afterLogin = await interactWithBrowserTab(tab.id, {
      type: 'type',
      text: 'comic123',
      pressEnter: true,
    });

    assert.equal(afterLogin.title, 'Member Chapter #9');
    assert.equal(afterLogin.discoveredImageCount, 1);
  } finally {
    await closeBrowserTab(tab.id);
  }
});

test('5. Lazy-loading auto-scroll loads deferred pages and flags SHA-256 duplicates', async () => {
  const tab = await createBrowserTab({
    url: `${baseUrl}/lazy-chapter`,
    allowLocalTestServer: true,
  });

  try {
    const res = await collectTabComicImages(tab.id, { autoScrollLazy: true });
    assert.equal(res.images.length, 3);
    const nonDuplicates = res.images.filter((i) => !i.isDuplicate);
    const duplicates = res.images.filter((i) => i.isDuplicate);
    assert.equal(nonDuplicates.length, 2);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].selected, false);
  } finally {
    await closeBrowserTab(tab.id);
  }
});

test('6. HTTP 403 / Cloudflare block is explicitly reported and NEVER treated as import success', async () => {
  const tab = await createBrowserTab({
    url: `${baseUrl}/blocked-403`,
    allowLocalTestServer: true,
  });

  try {
    assert.equal(tab.httpStatus, 403);
    assert.equal(tab.protectionStatus, 'http_403_blocked');

    const res = await collectTabComicImages(tab.id, { autoScrollLazy: true });
    assert.equal(res.blockedByProtection, true);
    assert.equal(res.images.length, 0);
  } finally {
    await closeBrowserTab(tab.id);
  }
});

test('7. Privacy incognito mode records zero browsing history entries', async () => {
  await updateBrowserPrivacySettings({ privacyMode: 'incognito', clearHistory: true });
  const beforeCount = getBrowserWorkspaceState().history.length;
  assert.equal(beforeCount, 0);

  const tab = await createBrowserTab({
    url: `${baseUrl}/chapter-1`,
    privacyMode: 'incognito',
    allowLocalTestServer: true,
  });
  try {
    await navigateBrowserTab(tab.id, `${baseUrl}/chapter-2`, {
      allowLocalTestServer: true,
    });
    const afterCount = getBrowserWorkspaceState().history.length;
    assert.equal(afterCount, 0);
  } finally {
    await closeBrowserTab(tab.id);
    await updateBrowserPrivacySettings({ privacyMode: 'standard', clearHistory: true });
  }
});

test('8. Android Share Intent /mobile/share-import handles CBZ archives and images cleanly', async () => {
  const db = getDb();
  const project = db.projects[0];
  assert.ok(project);

  const zip = new JSZip();
  zip.file('001.png', buildSolidPng(300, 400, 180, 90, 60));
  zip.file('002.png', buildSolidPng(300, 400, 60, 140, 200));
  const archiveBase64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');

  const res = await importMobileSharePayload({
    projectId: project.id,
    chapterTitle: 'Shared Issue #10',
    sourcePlatform: 'android_share_intent',
    archiveFilename: 'shared_issue_10.cbz',
    archiveBase64,
  });
  createdChapterIds.push(res.chapter.id);

  assert.equal(res.chapter.pageCount, 2);
  assert.equal(res.pages.length, 2);
  assert.equal(res.pages[0].pageNumber, 1);
  assert.equal(res.pages[1].pageNumber, 2);
  assert.ok(res.pages[0].originalImage.startsWith('/uploads/'));
});
