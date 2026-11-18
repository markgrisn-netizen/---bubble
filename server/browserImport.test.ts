import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPagesToBrowserSession,
  completeBrowserImportSession,
  createBrowserImportSession,
  getBrowserImportSessionPublic,
  validateAndDecodeImageDataUrl,
  verifyBrowserSessionAuth,
} from './browserImport.ts';
import { getDb, saveDb } from './store.ts';

const VALID_1X1_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('validateAndDecodeImageDataUrl verifies magic bytes and rejects forged payloads', () => {
  const valid = validateAndDecodeImageDataUrl(VALID_1X1_PNG);
  assert.equal(valid.mime, 'image/png');
  assert.ok(valid.sha256.length === 64);

  // Forged PNG header containing plain HTML text
  const fakePng = `data:image/png;base64,${Buffer.from('<html>not a png</html>').toString('base64')}`;
  assert.throws(() => validateAndDecodeImageDataUrl(fakePng));

  // Unsupported MIME
  assert.throws(() => validateAndDecodeImageDataUrl('data:text/html;base64,PGh0bWw+'));
});

test('browser import session enforces Pairing Token auth, stores images directly without refetching, and completes into studio chapter', () => {
  const db = getDb();
  const project = db.projects[0];
  assert.ok(project, 'Seeded project must exist');

  const { session, pairingToken } = createBrowserImportSession({
    projectId: project.id,
    chapterTitle: 'Browser Captured Test Chapter',
    targetUrl: 'https://protected-site.example/manga/ch-5',
  });

  // Token must NOT leak in public session view
  const publicView = getBrowserImportSessionPublic(session.id);
  assert.ok(publicView);
  assert.equal('tokenHash' in publicView, false);

  // Reject wrong/missing token
  assert.throws(() => verifyBrowserSessionAuth(session.id, 'wrong-token'));
  assert.throws(() => appendPagesToBrowserSession(session.id, '', [{ dataUrl: VALID_1X1_PNG }]));

  // Accept valid captured pages (strip query auth tokens from reference sourceUrl)
  const appended = appendPagesToBrowserSession(session.id, pairingToken, [
    {
      dataUrl: VALID_1X1_PNG,
      pageNumber: 1,
      sourceUrl: 'https://protected-site.example/manga/ch-5?token=secret123',
      width: 850,
      height: 1200,
      captureMethod: 'canvas_capture',
    },
    {
      dataUrl: VALID_1X1_PNG,
      pageNumber: 2,
      sourceUrl: 'https://protected-site.example/manga/ch-5?token=secret123',
      width: 850,
      height: 1200,
      captureMethod: 'visible_tab_crop',
    },
  ]);

  assert.equal(appended.addedCount, 2);
  assert.equal(appended.session.pages.length, 2);
  assert.equal(
    appended.session.pages[0].sourceUrl,
    'https://protected-site.example/manga/ch-5',
    'Query params / tokens stripped from reference URL'
  );

  // Complete into existing project & verify Chapter + Pages created in store
  const completed = completeBrowserImportSession(session.id, { bearerToken: pairingToken });
  try {
    assert.equal(completed.chapter.pageCount, 2);
    assert.equal(completed.pages.length, 2);
    assert.equal(completed.pages[0].status, 'pending');
    assert.ok(completed.pages[0].originalImage.startsWith('/uploads/'));
  } finally {
    db.chapters = db.chapters.filter((c) => c.id !== completed.chapter.id);
    db.pages = db.pages.filter((p) => p.chapterId !== completed.chapter.id);
    saveDb();
  }
});
