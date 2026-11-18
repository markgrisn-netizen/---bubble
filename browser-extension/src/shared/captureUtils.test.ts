import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUploadBatches,
  computeDataUrlSignature,
  decideImageCaptureStrategy,
  dedupeCapturedPages,
  detectProtectionChallenge,
  parsePairingInput,
  reorderCapturedPages,
} from './captureUtils.ts';
import type { CapturedPageItem } from './types.ts';

test('detectProtectionChallenge blocks Cloudflare WAF, CAPTCHA, and login walls from being captured as manga', () => {
  const cf = detectProtectionChallenge({
    title: 'Just a moment...',
    bodyText: 'Checking your browser before accessing',
    hasTurnstileIframe: true,
    visibleMangaImagesCount: 0,
  });
  assert.equal(cf.blocked, true);
  assert.equal(cf.kind, 'cloudflare_waf');

  const captcha = detectProtectionChallenge({
    title: 'Security Check',
    bodyText: 'Please solve g-recaptcha to proceed',
    hasRecaptchaIframe: true,
    visibleMangaImagesCount: 0,
  });
  assert.equal(captcha.blocked, true);
  assert.equal(captcha.kind, 'captcha');

  const loginGate = detectProtectionChallenge({
    title: 'Member Sign In',
    bodyText: 'Sign in with your account to read',
    hasPasswordInputOnly: true,
    visibleMangaImagesCount: 0,
  });
  assert.equal(loginGate.blocked, true);
  assert.equal(loginGate.kind, 'login_gate');

  // After user completes manual login/verification and manga pages appear:
  const okManga = detectProtectionChallenge({
    title: 'Chapter 42 — Reader',
    bodyText: 'Page 1 of 20',
    hasTurnstileIframe: false,
    hasPasswordInputOnly: false,
    visibleMangaImagesCount: 6,
  });
  assert.equal(okManga.blocked, false);
});

test('decideImageCaptureStrategy handles Canvas capture and CORS-tainted fallback cleanly', () => {
  assert.equal(
    decideImageCaptureStrategy({
      tagName: 'CANVAS',
      canvasExportSucceeded: true,
      isTaintedCorsError: false,
    }),
    'canvas_capture'
  );

  assert.equal(
    decideImageCaptureStrategy({
      tagName: 'IMG',
      canvasExportSucceeded: false,
      isTaintedCorsError: true,
    }),
    'visible_tab_crop'
  );

  assert.equal(
    decideImageCaptureStrategy({
      tagName: 'IMG',
      canvasExportSucceeded: true,
      isTaintedCorsError: false,
    }),
    'dom_image'
  );
});

test('parsePairingInput, dedupeCapturedPages, reorderCapturedPages, and buildUploadBatches work accurately', () => {
  const bundle = Buffer.from(
    JSON.stringify({
      appUrl: 'http://localhost:3000/',
      sessionId: 'bsess-1234',
      pairingToken: 'tok-abcdef',
      chapterTitle: 'Ch. 10',
    })
  ).toString('base64');

  const parsed = parsePairingInput(bundle);
  assert.equal(parsed.appUrl, 'http://localhost:3000');
  assert.equal(parsed.sessionId, 'bsess-1234');
  assert.equal(parsed.pairingToken, 'tok-abcdef');

  const imgA = 'data:image/png;base64,AAAA1111';
  const imgB = 'data:image/png;base64,BBBB2222';
  const pages: CapturedPageItem[] = [
    {
      id: '1',
      pageNumber: 1,
      dataUrl: imgA,
      sourceUrl: 'https://reader.example/1',
      width: 800,
      height: 1200,
      capturedAt: '2026-11-16T10:00:00Z',
      captureMethod: 'dom_image',
      signature: computeDataUrlSignature(imgA, 800, 1200),
      selected: true,
    },
    {
      id: '2',
      pageNumber: 2,
      dataUrl: imgA, // duplicate of #1
      sourceUrl: 'https://reader.example/1',
      width: 800,
      height: 1200,
      capturedAt: '2026-11-16T10:00:01Z',
      captureMethod: 'auto_collect',
      signature: computeDataUrlSignature(imgA, 800, 1200),
      selected: true,
    },
    {
      id: '3',
      pageNumber: 3,
      dataUrl: imgB,
      sourceUrl: 'https://reader.example/2',
      width: 800,
      height: 1200,
      capturedAt: '2026-11-16T10:00:02Z',
      captureMethod: 'visible_tab_crop',
      signature: computeDataUrlSignature(imgB, 800, 1200),
      selected: true,
    },
  ];

  const deduped = dedupeCapturedPages(pages);
  assert.equal(deduped.removedCount, 1);
  assert.equal(deduped.pages.length, 2);
  assert.equal(deduped.pages[1].pageNumber, 2);

  const reordered = reorderCapturedPages(deduped.pages, 0, 'down');
  assert.equal(reordered[0].id, '3');
  assert.equal(reordered[0].pageNumber, 1);
  assert.equal(reordered[1].id, '1');
  assert.equal(reordered[1].pageNumber, 2);

  const batches = buildUploadBatches(reordered, 1);
  assert.equal(batches.length, 2);
});
