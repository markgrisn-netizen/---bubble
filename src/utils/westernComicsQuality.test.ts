import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultFontSettings,
  exportGlossaryCsv,
  fitTextInRegion,
  normalizeGlossaryCategory,
  parseGlossaryCsv,
  sortRegionsByReadingOrder,
} from './bubbleLayout.ts';
import { sampleInteriorBackground } from './inpainting.ts';
import {
  buildComicAnalysisPrompt,
  buildComicTranslationInstruction,
} from '../../server/geminiService.ts';
import type { GlossaryCategory, GlossaryEntry, Point } from '../types/domain.ts';

function makeSolidBuffer(
  w: number,
  h: number,
  bg: [number, number, number],
  drawFn?: (x: number, y: number) => [number, number, number] | null
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rgb = drawFn?.(x, y) || bg;
      const idx = (y * w + x) * 4;
      buf[idx] = rgb[0];
      buf[idx + 1] = rgb[1];
      buf[idx + 2] = rgb[2];
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

const fullRectPoly = (w: number, h: number): Point[] => [
  { x: 0, y: 0 },
  { x: w - 1, y: 0 },
  { x: w - 1, y: h - 1 },
  { x: 0, y: h - 1 },
];

test('Scenario 1 & 4: Dialogue-dense multi-tier Western grid and overlapping speech bubbles stay distinct in LTR Z-order', () => {
  const panels = [
    { box: { x: 20, y: 20, width: 460, height: 300 } },
    { box: { x: 500, y: 20, width: 460, height: 300 } },
    { box: { x: 20, y: 340, width: 940, height: 320 } },
  ];

  // Overlapping pair inside Panel 1 + bubbles in Panels 2 & 3, passed out of order
  const regions = [
    { id: 'p3-bottom', boundingBox: { x: 120, y: 400, width: 220, height: 90 } },
    { id: 'p1-overlap-2', boundingBox: { x: 180, y: 110, width: 170, height: 80 } },
    { id: 'p2-right', boundingBox: { x: 550, y: 60, width: 210, height: 85 } },
    { id: 'p1-overlap-1', boundingBox: { x: 50, y: 50, width: 170, height: 80 } },
  ];

  const sorted = sortRegionsByReadingOrder(regions, 'ltr', panels);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ['p1-overlap-1', 'p1-overlap-2', 'p2-right', 'p3-bottom']
  );

  const prompt = buildComicAnalysisPrompt('ltr', 'superhero');
  assert.match(prompt, /NEVER merge two overlapping balloons/i);
  assert.match(prompt, /multi-tier Western comic grids/i);
});

test('Scenario 2: Small and large speech bubbles auto-fit and balance Arabic/English lines cleanly', () => {
  const monoMeasure = (str: string, sizePx: number) => str.length * sizePx * 0.56;

  // Small tight bubble
  const smallFit = fitTextInRegion(
    'اثبت في موقعك يا سينتينيل!',
    130,
    70,
    { fontSize: 18, lineHeight: 1.38, padding: 11, autoFit: true, align: 'center' },
    monoMeasure
  );
  assert.equal(smallFit.overflowed, false, 'Tight bubble text should shrink cleanly to fit without overflow');
  assert.ok(smallFit.lines.length >= 2);
  assert.ok(smallFit.fontSize < 18);

  // Large hero balloon should avoid single orphan word on last line when possible
  const largeFit = fitTextInRegion(
    'WE HOLD THE METROPOLIS LINE TOGETHER NOW!',
    260,
    150,
    { fontSize: 18, lineHeight: 1.2, padding: 11, autoFit: true, align: 'center' },
    monoMeasure
  );
  assert.equal(largeFit.overflowed, false);
  const lastWords = largeFit.lines[largeFit.lines.length - 1].trim().split(/\s+/);
  assert.ok(lastWords.length >= 2, `Expected balanced lines without 1-word orphan, got: ${JSON.stringify(largeFit.lines)}`);
});

test('Scenario 3 & 8: Narration yellow caption boxes & dark/noir speech bubbles are accurately sampled', () => {
  const w = 120;
  const h = 80;
  const poly = fullRectPoly(w, h);

  // Scenario 3: Yellow Western narration caption box with black lettering in center
  const yellowCaptionBuf = makeSolidBuffer(w, h, [248, 208, 48], (x, y) => {
    if (x > 35 && x < 85 && y > 32 && y < 48) return [15, 15, 15];
    return null;
  });
  const yellowStats = sampleInteriorBackground(yellowCaptionBuf, w, h, poly, 0, 0, w - 1, h - 1);
  assert.equal(yellowStats.isUniform, true);
  assert.equal(yellowStats.isDark, false);
  assert.ok(yellowStats.r > 220 && yellowStats.g > 180 && yellowStats.b < 80);

  // Scenario 8: Dark/Noir speech bubble (#14161A) with white text inside
  const darkBubbleBuf = makeSolidBuffer(w, h, [20, 22, 26], (x, y) => {
    if (x > 36 && x < 84 && y > 32 && y < 48) return [248, 248, 248];
    return null;
  });
  const darkStats = sampleInteriorBackground(darkBubbleBuf, w, h, poly, 0, 0, w - 1, h - 1);
  assert.equal(darkStats.isUniform, true);
  assert.equal(darkStats.isDark, true, 'Dark/noir bubble must be flagged as dark background (luma < 95)');
  assert.ok(darkStats.luma < 95);
});

test('Scenario 5, 6 & 7: Outside artwork text, large SFX defaults, and variegated full-color pages', () => {
  // Scenario 5: Outside text defaults (Arabic & English) carry crisp halo stroke
  const arOutside = createDefaultFontSettings('ar', 'outside', 'european');
  assert.equal(arOutside.direction, 'rtl');
  assert.equal(arOutside.strokeColor, '#FFFFFF');
  assert.ok((arOutside.strokeWidth || 0) >= 3);

  const enOutside = createDefaultFontSettings('en', 'outside', 'american');
  assert.equal(enOutside.direction, 'ltr');
  assert.equal(enOutside.letterCase, 'uppercase');
  assert.equal(enOutside.strokeColor, '#FFFFFF');

  // Scenario 6: Large stylized SFX defaults
  const arSfx = createDefaultFontSettings('ar', 'sfx', 'superhero');
  assert.equal(arSfx.fontFamily, 'Lalezar');
  assert.equal(arSfx.color, '#DC2626');

  const enSfx = createDefaultFontSettings('en', 'sfx', 'superhero');
  assert.equal(enSfx.fontFamily, 'Bangers');
  assert.equal(enSfx.letterCase, 'uppercase');

  // Scenario 7: Full-color non-uniform gradient artwork reports isUniform=false
  const w = 100;
  const h = 100;
  const colorArtworkBuf = makeSolidBuffer(w, h, [0, 0, 0], (x, y) => [
    (x * 3) % 255,
    (y * 3) % 255,
    ((x + y) * 2) % 255,
  ]);
  const artStats = sampleInteriorBackground(colorArtworkBuf, w, h, fullRectPoly(w, h), 0, 0, w - 1, h - 1);
  assert.equal(artStats.isUniform, false);
});

test('Bidirectional EN -> AR & AR -> EN translation prompts and 10-category Comics Glossary', () => {
  const categories: GlossaryCategory[] = [
    'character',
    'title',
    'team',
    'power',
    'ability',
    'place',
    'military',
    'scientific',
    'fantasy',
    'sfx',
  ];

  const entries: GlossaryEntry[] = categories.map((cat, idx) => ({
    id: `g-${idx}`,
    projectId: 'proj-test',
    originalTerm: `Term_${cat}`,
    translatedTerm: `ترجمة_${cat}`,
    category: cat,
    notes: `Note for ${cat}`,
  }));

  // CSV round-trip preserves all 10 specialized categories
  const csv = exportGlossaryCsv(entries);
  const reparsed = parseGlossaryCsv(csv);
  assert.equal(reparsed.length, 10);
  for (let i = 0; i < categories.length; i++) {
    assert.equal(reparsed[i].category, categories[i]);
    assert.equal(normalizeGlossaryCategory(categories[i].toUpperCase()), categories[i]);
  }

  // EN -> AR cinematic MSA instruction
  const enToArPrompt = buildComicTranslationInstruction({
    project: {
      title: 'Apex Vanguard',
      comicFormat: 'superhero',
      sourceLanguage: 'en',
      targetLanguage: 'ar',
    },
    storyMemory: {
      characters: [
        {
          id: 'c1',
          name: 'Sentinel',
          translatedName: 'سينتينيل',
          speechStyle: 'Heroic and composed',
          relations: 'Leader of Apex Vanguard',
        },
      ],
      locations: ['New Metro'],
      recurringNotes: 'Keep superhero tone punchy.',
      chapterSummaries: ['Reactor breached.'],
    },
    glossary: entries,
    style: 'cinematic',
    targetLanguage: 'ar',
    regionsText: 'Term_character activates Term_power at Term_military base.',
    previousPageContext: 'Commander Vance: "Brace for impact!" -> "استعدوا للصدمة!"',
  });

  assert.match(enToArPrompt, /English -> Arabic/i);
  assert.match(enToArPrompt, /فصحى سينمائية/);
  assert.match(enToArPrompt, /NEVER translate literally/i);
  assert.match(enToArPrompt, /Term_character" => "ترجمة_character" \[character\]/);
  assert.match(enToArPrompt, /Term_power" => "ترجمة_power" \[power\]/);
  assert.match(enToArPrompt, /Term_military" => "ترجمة_military" \[military\]/);
  assert.match(enToArPrompt, /Commander Vance/);

  // AR -> EN authentic Western comic lettering instruction
  const arToEnPrompt = buildComicTranslationInstruction({
    project: {
      title: 'حماة المجرة',
      comicFormat: 'american',
      sourceLanguage: 'ar',
      targetLanguage: 'en',
    },
    storyMemory: {
      characters: [],
      locations: [],
      recurringNotes: '',
      chapterSummaries: [],
    },
    glossary: entries,
    style: 'natural_pro',
    targetLanguage: 'en',
    regionsText: 'Term_scientific',
  });

  assert.match(arToEnPrompt, /Arabic -> English/i);
  assert.match(arToEnPrompt, /Western comic-book English lettering/i);
  assert.match(arToEnPrompt, /Term_scientific" => "ترجمة_scientific" \[scientific\]/);
});
