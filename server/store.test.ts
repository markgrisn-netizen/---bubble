import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './store';
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
