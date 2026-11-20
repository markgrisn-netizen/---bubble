import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  getDb,
  getUploadsDir,
  reloadDbFromDiskForTest,
  saveBase64Asset,
  saveDb,
  validateImageBuffer,
  verifyImageAssetUrl,
} from './store';
import { recoverInterruptedJobsOnStartup } from './jobRunner';
import { validatePublicChapterUrl } from './urlImporter';

test('database seeds initial manga project with chapters, pages, bubbles, and glossary', () => {
  const db = getDb();
  assert.ok(db.projects.length >= 1, 'Expected at least 1 seeded project');
  assert.ok(db.chapters.length >= 2, 'Expected at least 2 seeded chapters');
  assert.ok(db.pages.length >= 3, 'Expected at least 3 seeded pages');
  assert.ok(db.pages[0].regions.length >= 4, 'Expected seeded bubbles on page 1');
  assert.ok(db.glossary.some((g) => g.originalTerm === 'Wismerhill'), 'Expected Wismerhill glossary entry');
});

test('validatePublicChapterUrl rejects localhost/private IPs and accepts public HTTPS URLs', () => {
  assert.throws(() => validatePublicChapterUrl('http://localhost:3000/secret'));
  assert.throws(() => validatePublicChapterUrl('http://127.0.0.1/admin'));
  assert.throws(() => validatePublicChapterUrl('ftp://example.com/file'));
  assert.throws(() => validatePublicChapterUrl('not a url'));

  const valid = validatePublicChapterUrl('https://example.com/manga/chapter-1');
  assert.equal(valid.hostname, 'example.com');
});

test('saveBase64Asset rejects corrupted payloads without .tmp leftovers and persists valid PNG atomically', () => {
  const uploadsDir = getUploadsDir();
  assert.throws(() => saveBase64Asset('data:image/png;base64,AAAA', 'bad_test'));
  assert.throws(() => saveBase64Asset('', 'empty_test'));

  const leftoverTmps = fs.readdirSync(uploadsDir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftoverTmps.length, 0, 'No orphan .tmp files may remain after rejected writes');

  // Minimal valid 1x1 PNG buffer (>16 bytes)
  const validPngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const saved = saveBase64Asset(`data:image/png;base64,${validPngB64}`, 'unit_test_ok');
  try {
    const bufCheck = validateImageBuffer(fs.readFileSync(saved.filePath));
    assert.equal(bufCheck.valid, true);
    assert.equal(bufCheck.ext, 'png');
    assert.equal(verifyImageAssetUrl(saved.url).ok, true);
  } finally {
    if (fs.existsSync(saved.filePath)) fs.unlinkSync(saved.filePath);
  }
});

test('getDb recovers automatically from db.json.bak when primary db.json is corrupted', () => {
  const dbFile = path.resolve(process.cwd(), 'data', 'db.json');
  const bakFile = `${dbFile}.bak`;
  const db = getDb();
  const originalProjectCount = db.projects.length;
  saveDb(); // Ensure primary + backup match cleanly
  saveDb(); // Write second commit so .bak holds valid previous db.json

  const validSnapshot = fs.readFileSync(dbFile, 'utf-8');
  assert.ok(fs.existsSync(bakFile), 'Expected db.json.bak to exist after saveDb');

  try {
    fs.writeFileSync(dbFile, '{corrupted_json_crash_test', 'utf-8');
    const recovered = reloadDbFromDiskForTest();
    assert.equal(recovered.projects.length, originalProjectCount);
  } finally {
    fs.writeFileSync(dbFile, validSnapshot, 'utf-8');
    reloadDbFromDiskForTest();
  }
});

test('recoverInterruptedJobsOnStartup resets in-flight paused/crashed pages while keeping completed pages intact', () => {
  const db = getDb();
  const page1 = db.pages[0];
  const prevStatus = page1.status;
  const syntheticJobId = 'job-recovery-test';
  const chapterId = page1.chapterId;

  // Put a completed job shell with 1 paused-looking interrupted state (without calling AI)
  const cleanJob = {
    id: syntheticJobId,
    projectId: db.projects[0].id,
    chapterId,
    chapterTitle: 'Recovery Test Chapter',
    status: 'paused' as const,
    totalPages: 2,
    completedPages: 1,
    failedPages: 0,
    progress: 50,
    batchSize: 2,
    currentBatch: 1,
    totalBatches: 1,
    activeProvider: 'gemini' as const,
    activeModel: 'gemini-4-hydrogen',
    pageStates: {
      [page1.id]: 'completed' as const,
      'missing-inflight-page': 'queued' as const,
    },
    createdAt: new Date().toISOString(),
  };

  try {
    db.jobs.unshift(cleanJob);
    page1.status = 'translating';
    saveDb();

    const recovery = recoverInterruptedJobsOnStartup();
    assert.ok(recovery.resetPageIds.includes(page1.id), 'Orphaned translating page should be reset cleanly');
    assert.equal(
      page1.status,
      page1.regions.length > 0 ? 'analyzed' : 'pending',
      'Analyzed regions should be preserved when recovering interrupted translating status'
    );
    assert.equal(cleanJob.pageStates[page1.id], 'completed', 'Completed pageStates entry must stay untouched');
  } finally {
    page1.status = prevStatus;
    db.jobs = db.jobs.filter((j) => j.id !== syntheticJobId);
    saveDb();
  }
});

