import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  AiSettings,
  ComicFormat,
  GlossaryEntry,
  Page,
  Project,
  ReadingDirection,
  StoryMemory,
  TextRegion,
  TranslationStyle,
} from '../src/types/domain.ts';
import {
  boxToPolygon,
  createDefaultFontSettings,
  findMatchingGlossaryTerms,
  sortRegionsByReadingOrder,
} from '../src/utils/bubbleLayout.ts';
import {
  buildThinkingConfigForModel,
  executeWithGeminiResilience,
  normalizeGeminiModel,
} from './geminiResilience.ts';

import { getVaultSecret } from './secretVault.ts';

export function resolveGeminiApiKey(overrideKey?: string): string | undefined {
  const explicit = overrideKey?.trim();
  if (explicit && explicit !== 'MY_GEMINI_API_KEY') return explicit;
  const vault = getVaultSecret('gemini')?.apiKey?.trim();
  if (vault && vault !== 'MY_GEMINI_API_KEY') return vault;
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && envKey !== 'MY_GEMINI_API_KEY') return envKey;
  return undefined;
}

function getAiClient(overrideKey?: string, overrideEndpoint?: string): GoogleGenAI {
  const apiKey = resolveGeminiApiKey(overrideKey);
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Add your Gemini API key in Settings or AI Studio Secrets.'
    );
  }
  const cleanEndpoint = overrideEndpoint?.trim().replace(/\/+$/, '');
  const useCustomBaseUrl =
    cleanEndpoint && cleanEndpoint !== 'https://generativelanguage.googleapis.com';
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(useCustomBaseUrl ? { baseUrl: cleanEndpoint } : {}),
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  return Boolean(resolveGeminiApiKey());
}

export async function testAiConnection(
  modelName = 'gemini-4-hydrogen',
  options?: {
    apiKey?: string;
    endpointUrl?: string;
    visionModel?: string;
    testVisionPngBase64?: string;
  }
): Promise<{
  ok: boolean;
  model: string;
  visionModel?: string;
  translationVerified: boolean;
  visionVerified?: boolean;
  latencyMs: number;
  message: string;
  visionMessage?: string;
  fallbackUsed?: boolean;
}> {
  const start = Date.now();
  const ai = getAiClient(options?.apiKey, options?.endpointUrl);
  const validModel = normalizeGeminiModel(modelName);

  // Real micro-translation probe (not just a key check)
  const resilient = await executeWithGeminiResilience({
    primaryModel: validModel,
    operationName: 'testAiConnection',
    maxRetriesPrimary: 1,
    maxRetriesFallback: 0,
    run: async (model) => {
      const thinkingConfig = buildThinkingConfigForModel(model);
      return ai.models.generateContent({
        model,
        contents: 'Translate this comic greeting to Arabic and reply ONLY with the Arabic translation: "Hold the line!"',
        config: thinkingConfig ? { thinkingConfig } : undefined,
      });
    },
  });

  const translatedReply = (resilient.result.text || '').trim();
  const translationVerified = translatedReply.length > 0;

  let visionVerified: boolean | undefined;
  let visionMessage: string | undefined;
  let visionModelUsed: string | undefined;

  if (options?.testVisionPngBase64) {
    const vModel = normalizeGeminiModel(options.visionModel || validModel);
    visionModelUsed = vModel;
    const thinkingConfig = buildThinkingConfigForModel(vModel);
    const vRes = await ai.models.generateContent({
      model: vModel,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: options.testVisionPngBase64,
            },
          },
          {
            text: 'Confirm you received this test PNG image and describe what you see in one short phrase.',
          },
        ],
      },
      config: thinkingConfig ? { thinkingConfig } : undefined,
    });
    const vText = (vRes.text || '').trim();
    visionVerified = vText.length > 0;
    visionMessage = vText || 'Vision OK';
  }

  return {
    ok: translationVerified && (visionVerified === undefined || visionVerified),
    model: resilient.modelUsed,
    visionModel: visionModelUsed,
    translationVerified,
    visionVerified,
    fallbackUsed: resilient.fallbackUsed,
    latencyMs: Date.now() - start,
    message: translatedReply || 'READY',
    visionMessage,
  };
}

/**
 * Loads an image from disk (/uploads/..., /src/assets/...) or data URL as base64 + mimeType.
 */
export function resolveImageBase64(imageSrc: string): { base64: string; mimeType: string } {
  if (imageSrc.startsWith('data:')) {
    const match = imageSrc.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid base64 image format');
    return { mimeType: match[1], base64: match[2] };
  }

  let absPath = '';
  if (imageSrc.startsWith('/uploads/')) {
    absPath = path.resolve(process.cwd(), 'data', imageSrc.replace(/^\//, ''));
  } else if (imageSrc.startsWith('/src/')) {
    absPath = path.resolve(process.cwd(), imageSrc.replace(/^\//, ''));
  } else {
    throw new Error(`Unsupported local image path: ${imageSrc}`);
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(`[SOURCE_IMAGE_MISSING] تعذّر العثور على ملف الصورة على الخادم: ${imageSrc}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  const mimeType =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const buf = fs.readFileSync(absPath);
  return { mimeType, base64: buf.toString('base64') };
}

interface RawDetectedRegion {
  regionType: 'dialogue' | 'narration' | 'sfx' | 'outside';
  x: number;
  y: number;
  width: number;
  height: number;
  originalText: string;
  sourceLanguage: string;
  confidence: number;
  speaker?: string;
  isDarkBackground?: boolean;
}

const FORMAT_LABELS: Record<ComicFormat, string> = {
  superhero: 'Superhero Comics',
  american: 'American Comics',
  british: 'British Comics',
  european: 'European Comics (Bande Dessinée / Graphic)',
  graphic_novel: 'Graphic Novel',
  indie: 'Independent Comics',
  comic: 'Western Comics',
  manga: 'Manga (Secondary)',
  manhwa: 'Manhwa (Secondary)',
  manhua: 'Manhua (Secondary)',
  webtoon: 'Webtoon (Secondary)',
};

export function buildComicAnalysisPrompt(
  readingDirection: ReadingDirection,
  comicFormat: ComicFormat = 'superhero'
): string {
  const formatName = FORMAT_LABELS[comicFormat] || 'Western Comics';
  return `You are an elite Computer Vision & OCR engine specialized first in Western Comics (${formatName}), with secondary support for Manga/Manhwa.
Inspect the provided comic page image with extreme precision.
1. Detect ALL comic panels (including multi-tier Western comic grids, inset panels, and splashes) with canonical TOP-LEFT normalized [0..1000] bounding boxes {x, y, width, height} relative to the full original image width and height (x=0 is left edge, y=0 is top edge; NEVER return center coordinates or [ymin, xmin, ymax, xmax] order, and NEVER return 0..1 floats).
2. Detect EVERY speech balloon, narration caption box, floating text over artwork, and stylized sound effect (SFX) with tight, centered canonical TOP-LEFT normalized [0..1000] bounding boxes {x, y, width, height}:
   - CRITICAL GEOMETRY: Frame the interior text block of each balloon/box symmetrically so (x + width/2, y + height/2) sits directly at the visual center of the printed lettering inside that balloon. Do NOT include blank balloon tails or neighboring balloons in the width/height.
   - CRITICAL SEPARATION: Separate overlapping or stacked speech balloons into distinct bounding boxes — NEVER merge two overlapping balloons!
   - Handle white/cream balloons, dark/black/colored balloons (with white or yellow lettering), rectangular/skewed narration caption boxes, floating text over detailed color artwork ("outside"), and large hand-drawn SFX ("sfx").
   - Extract exact OCR text preserving original script, emphasis punctuation, and line flow (primarily English or Arabic, or Japanese/Korean/French when secondary format).
   - Set regionType accurately: "dialogue" | "narration" | "sfx" | "outside".
   - Set isDarkBackground: true if the bubble/box interior has a dark fill (black, dark navy, dark crimson, deep shadow) with light-colored lettering.
   - Identify speaker name/role from visual balloon tails or context when clear.
   - Reading direction context: ${readingDirection}.`;
}

export function buildAnalyzedPageResult(
  page: Page,
  parsed: {
    panels?: Array<{ x: number; y: number; width: number; height: number }>;
    regions?: RawDetectedRegion[];
  },
  readingDirection: ReadingDirection,
  targetLanguage = 'ar',
  comicFormat: ComicFormat = 'superhero'
): { panels: Page['panels']; regions: TextRegion[] } {
  const rawCoords: number[] = [];
  for (const p of parsed.panels || []) {
    rawCoords.push(Number(p.x) || 0, Number(p.y) || 0, Number(p.width) || 0, Number(p.height) || 0);
  }
  for (const r of parsed.regions || []) {
    rawCoords.push(Number(r.x) || 0, Number(r.y) || 0, Number(r.width) || 0, Number(r.height) || 0);
  }
  const hasPositiveCoords = rawCoords.some((n) => n > 0);
  const needsUnitScale = hasPositiveCoords && rawCoords.every((n) => n <= 1.5);
  const coordMultiplier = needsUnitScale ? 1000 : 1;

  const panels: Page['panels'] = (parsed.panels || []).map((p, idx) => {
    const px = (Number(p.x) || 0) * coordMultiplier;
    const py = (Number(p.y) || 0) * coordMultiplier;
    const pw = (Number(p.width) || (needsUnitScale ? 0.1 : 100)) * coordMultiplier;
    const ph = (Number(p.height) || (needsUnitScale ? 0.1 : 100)) * coordMultiplier;
    const clampedX = Math.max(0, Math.min(990, px));
    const clampedY = Math.max(0, Math.min(990, py));
    return {
      id: `panel-${page.id}-${idx + 1}`,
      box: {
        x: clampedX,
        y: clampedY,
        width: Math.max(20, Math.min(1000 - clampedX, pw)),
        height: Math.max(20, Math.min(1000 - clampedY, ph)),
      },
      readingOrder: idx + 1,
    };
  });

  const orderedRaw = sortRegionsByReadingOrder(
    (parsed.regions || []).map((r) => {
      const rx = (Number(r.x) || 0) * coordMultiplier;
      const ry = (Number(r.y) || 0) * coordMultiplier;
      const rw = (Number(r.width) || (needsUnitScale ? 0.08 : 80)) * coordMultiplier;
      const rh = (Number(r.height) || (needsUnitScale ? 0.05 : 50)) * coordMultiplier;
      const clampedX = Math.max(0, Math.min(980, rx));
      const clampedY = Math.max(0, Math.min(980, ry));
      return {
        ...r,
        boundingBox: {
          x: clampedX,
          y: clampedY,
          width: Math.max(20, Math.min(1000 - clampedX, rw)),
          height: Math.max(20, Math.min(1000 - clampedY, rh)),
        },
      };
    }),
    readingDirection,
    panels
  );

  const regions: TextRegion[] = orderedRaw.map((r, idx) => {
    const regionType: TextRegion['regionType'] =
      r.regionType === 'narration' || r.regionType === 'sfx' || r.regionType === 'outside'
        ? r.regionType
        : 'dialogue';
    const fontSettings = createDefaultFontSettings(targetLanguage, regionType, comicFormat);
    if (r.isDarkBackground && regionType !== 'sfx') {
      fontSettings.color = '#FFFFFF';
    }
    return {
      id: `reg-${page.id}-${Date.now()}-${idx + 1}`,
      pageId: page.id,
      regionType,
      boundingBox: r.boundingBox,
      boundingPolygon: boxToPolygon(r.boundingBox),
      originalText: (r.originalText || '').trim(),
      translatedText: '',
      alternatives: [],
      sourceLanguage: r.sourceLanguage || 'en',
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.9)),
      readingOrder: idx + 1,
      speaker: r.speaker || undefined,
      fontSettings,
      cleanMode: regionType === 'sfx' ? 'keep' : 'auto',
      sfxMode: regionType === 'sfx' ? 'side' : 'keep',
      approvalStatus: 'pending',
      translationStatus: 'untranslated',
    };
  });

  return { panels, regions };
}

/**
 * Specialized Western Comics (and secondary Manga/Manhwa) Computer Vision & OCR via Gemini Multimodal.
 */
export async function analyzeComicPage(
  page: Page,
  readingDirection: ReadingDirection,
  settings: AiSettings,
  options?: { targetLanguage?: string; comicFormat?: ComicFormat }
): Promise<{ panels: Page['panels']; regions: TextRegion[] }> {
  const ai = getAiClient(undefined, settings?.providers?.gemini?.endpointUrl);
  const { base64, mimeType } = resolveImageBase64(page.originalImage);
  const primaryModel = normalizeGeminiModel(settings.visionOcrModel);

  const comicFormat = options?.comicFormat || 'superhero';
  const targetLanguage = options?.targetLanguage || 'ar';
  const systemInstruction = buildComicAnalysisPrompt(readingDirection, comicFormat);

  const { result: response } = await executeWithGeminiResilience({
    primaryModel,
    operationName: 'analyzeComicPage',
    run: async (model) =>
      ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { mimeType, data: base64 } },
            {
              text: `Analyze this ${FORMAT_LABELS[comicFormat] || 'Western Comic'} page (reading direction: ${readingDirection}). Return every panel, speech balloon, narration caption box, overlapping bubble, floating artwork text, and SFX with accurate OCR and normalized 0..1000 bounding boxes.`,
            },
          ],
        },
        config: {
          systemInstruction,
          thinkingConfig: buildThinkingConfigForModel(model),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              panels: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    width: { type: Type.NUMBER },
                    height: { type: Type.NUMBER },
                  },
                  required: ['x', 'y', 'width', 'height'],
                },
              },
              regions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    regionType: { type: Type.STRING },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    width: { type: Type.NUMBER },
                    height: { type: Type.NUMBER },
                    originalText: { type: Type.STRING },
                    sourceLanguage: { type: Type.STRING },
                    confidence: { type: Type.NUMBER },
                    speaker: { type: Type.STRING },
                    isDarkBackground: { type: Type.BOOLEAN },
                  },
                  required: [
                    'regionType',
                    'x',
                    'y',
                    'width',
                    'height',
                    'originalText',
                    'sourceLanguage',
                    'confidence',
                  ],
                },
              },
            },
            required: ['panels', 'regions'],
          },
        },
      }),
  });

  const parsed = JSON.parse((response.text || '{"panels":[],"regions":[]}').trim()) as {
    panels: Array<{ x: number; y: number; width: number; height: number }>;
    regions: RawDetectedRegion[];
  };

  return buildAnalyzedPageResult(page, parsed, readingDirection, targetLanguage, comicFormat);
}

// Backward-compatible alias
export const analyzeMangaPage = analyzeComicPage;

const STYLE_INSTRUCTIONS: Record<TranslationStyle, string> = {
  cinematic:
    'Dramatic, punchy, high-impact cinematic Western comic dialogue fitting superhero tension and narrative momentum.',
  natural_pro:
    'Natural, idiomatic, publication-grade Western comic localization that reads as if originally written in the target language.',
  faithful:
    'Strictly faithful to original nuances, idioms, subtext, and speaker intent without stiff literalism.',
  literary:
    'Eloquent literary Modern Standard Arabic (فصحى رصينة) or refined graphic-novel English prose.',
  simplified: 'Clear, accessible, concise phrasing optimized for tight speech balloons.',
  literal: 'Close literal translation for side-by-side reference.',
  character_voice:
    'Distinctively tailored to each speaker persona, rank, age, humor, and speech quirks.',
};

export function buildComicTranslationInstruction(params: {
  project: Pick<Project, 'title' | 'comicFormat' | 'sourceLanguage' | 'targetLanguage'>;
  storyMemory: StoryMemory;
  glossary: GlossaryEntry[];
  style: TranslationStyle;
  targetLanguage: string;
  regionsText?: string;
  previousPageContext?: string;
}): string {
  const { project, storyMemory, glossary, style, targetLanguage, regionsText, previousPageContext } =
    params;

  const isEnToAr =
    targetLanguage.toLowerCase().startsWith('ar') || targetLanguage.includes('العربية');
  const isArToEn =
    targetLanguage.toLowerCase().startsWith('en') ||
    project.sourceLanguage.toLowerCase().startsWith('ar');

  const combinedText = regionsText || '';
  const matchedGlossary = combinedText
    ? findMatchingGlossaryTerms(combinedText, glossary)
    : [];
  const relevantGlossary =
    matchedGlossary.length > 0 ? matchedGlossary : glossary.slice(0, 40);

  const glossaryBlock = relevantGlossary.length
    ? relevantGlossary
        .map(
          (g) =>
            `- "${g.originalTerm}" => "${g.translatedTerm}" [${g.category}]${
              g.notes ? ` (${g.notes})` : ''
            }`
        )
        .join('\n')
    : 'None';

  const characterBlock = storyMemory.characters.length
    ? storyMemory.characters
        .map((c) => `- ${c.name} (${c.translatedName}): ${c.speechStyle} | ${c.relations}`)
        .join('\n')
    : 'None';

  const locationsBlock = storyMemory.locations?.length ? storyMemory.locations.join(', ') : 'None';
  const loreBlock = storyMemory.loreTerms?.length ? storyMemory.loreTerms.join(', ') : 'None';
  const relationshipsBlock = storyMemory.relationships?.length
    ? storyMemory.relationships.join(' | ')
    : 'None';
  const keyFactsBlock = storyMemory.keyFacts?.length
    ? storyMemory.keyFacts.slice(-8).join(' | ')
    : 'None';
  const decisionsBlock = storyMemory.translationDecisions?.length
    ? storyMemory.translationDecisions
        .slice(-15)
        .map((d) => `"${d.original}" => "${d.translated}"`)
        .join(', ')
    : 'None';

  const directionGuidance = isEnToAr
    ? `PRIMARY DIRECTION: English -> Arabic (Western Comics: ${FORMAT_LABELS[project.comicFormat] || 'Western Comics'}).
- Use authoritative, cinematic Modern Standard Arabic (فصحى سينمائية طبيعية وجذابة) suited for Western superhero, American, British, European comics, and graphic novels.
- NEVER translate literally or stiffly (تجنب الترجمة الحرفية الجامدة); capture idioms, dry wit, military commands, scientific jargon, and emotional punch naturally.
- Preserve every character name, superhero alias, team name, title, superpower, location, and military/sci-fi/fantasy term consistently across issues.
- Respect each speech balloon's physical dimensions (boxWidth x boxHeight): keep phrasing tight and balanced for balloons WITHOUT dropping essential meaning or damaging the dialogue.`
    : isArToEn
    ? `REVERSE DIRECTION: Arabic -> English (Western Comics: ${FORMAT_LABELS[project.comicFormat] || 'Western Comics'}).
- Use authentic, natural Western comic-book English lettering idioms, dramatic pacing, natural contractions, and crisp caption-box prose.
- Preserve speaker voice, honorifics, humor, and emotional stakes while fitting balloon geometry cleanly.
- Render SFX as punchy classic English comic sound effects (e.g., KRAAK!, THWIP!, BOOM!, WHOOSH!).`
    : `Target Language: ${targetLanguage}. Produce natural, publication-grade comic dialogue preserving tone and balloon fit.`;

  return `You are a master Western Comics & Graphic Novel translator specializing in English <-> Arabic localization.
${directionGuidance}

Translation Style: ${STYLE_INSTRUCTIONS[style]}

Mandatory Quality & Grounding Rules:
1. Read all regions in sequence across the entire page AND use previous-page context — NEVER translate bubbles in isolation.
2. Strictly enforce every approved entry in the Specialized Comics Glossary and Persistent Story Memory (characters, spellings, locations, lore terms, relationships, speech tones, past translation decisions).
3. ANTI-HALLUCINATION RULE (CRITICAL): Translate ONLY the visible originalText in the provided regions. NEVER invent unseen dialogue, events, characters, or lore not directly evidenced on the page or in prior verified Story Memory.
4. Respect balloon width/height metadata so dialogue fits cleanly without awkward truncation or loss of meaning.
5. For SFX (sound effects), craft vivid comic onomatopoeia appropriate to the action.
6. Provide 2-3 high-quality alternative translations per region.
7. Optionally populate memoryUpdate ONLY with genuinely new or refined story facts observed in the provided regions (no speculation).

Specialized Comics Glossary (MUST ENFORCE):
${glossaryBlock}

Persistent Story Memory:
- Characters & Speech Tones:
${characterBlock}
- Locations: ${locationsBlock}
- Lore / World Terms: ${loreBlock}
- Relationships: ${relationshipsBlock}
- Established Key Facts: ${keyFactsBlock}
- Recurring Translation Decisions: ${decisionsBlock}

Adjacent Page Context:
${previousPageContext || 'Start of scene / no prior page context'}

Story Context Notes:
${storyMemory.recurringNotes || 'N/A'}
Running Plot Summary:
${storyMemory.chapterSummaries.slice(-5).join(' | ') || 'N/A'}`;
}

export interface StoryMemoryDelta {
  characters?: Array<{
    name: string;
    translatedName: string;
    speechStyle?: string;
    relations?: string;
  }>;
  locations?: string[];
  loreTerms?: string[];
  relationships?: string[];
  keyFacts?: string[];
  translationDecisions?: Array<{
    original: string;
    translated: string;
    context?: string;
  }>;
  summaryAddition?: string;
}

/**
 * Context-aware Western Comic translator using Story Memory + 10-category Comics Glossary + Cross-Page Context.
 */
export async function translateRegionsWithContext(
  regions: TextRegion[],
  project: Project,
  storyMemory: StoryMemory,
  glossary: GlossaryEntry[],
  style: TranslationStyle,
  targetLanguage: string,
  settings: AiSettings,
  previousPageContext?: string
): Promise<{
  translations: Array<{ id: string; translatedText: string; alternatives: string[]; speaker?: string }>;
  summaryAddition?: string;
  memoryUpdate?: StoryMemoryDelta;
}> {
  if (!regions.length) return { translations: [] };

  const ai = getAiClient(undefined, settings?.providers?.gemini?.endpointUrl);
  const primaryModel = normalizeGeminiModel(settings.translationModel);

  const combinedText = regions.map((r) => r.originalText).join('\n');
  const systemInstruction = buildComicTranslationInstruction({
    project,
    storyMemory,
    glossary,
    style,
    targetLanguage,
    regionsText: combinedText,
    previousPageContext,
  });

  const payload = regions.map((r) => ({
    id: r.id,
    readingOrder: r.readingOrder,
    regionType: r.regionType,
    speaker: r.speaker || 'Unknown',
    sourceLanguage: r.sourceLanguage,
    boxWidth: Math.round(r.boundingBox.width),
    boxHeight: Math.round(r.boundingBox.height),
    originalText: r.originalText,
  }));

  const { result: response } = await executeWithGeminiResilience({
    primaryModel,
    operationName: 'translateRegionsWithContext',
    run: async (model) =>
      ai.models.generateContent({
        model,
        contents: `Translate the following ordered ${FORMAT_LABELS[project.comicFormat] || 'Western Comic'} regions into ${targetLanguage}:\n${JSON.stringify(payload, null, 2)}`,
        config: {
          systemInstruction,
          thinkingConfig: buildThinkingConfigForModel(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          translations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                translatedText: { type: Type.STRING },
                alternatives: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                speaker: { type: Type.STRING },
              },
              required: ['id', 'translatedText', 'alternatives'],
            },
          },
          summaryAddition: { type: Type.STRING },
          memoryUpdate: {
            type: Type.OBJECT,
            properties: {
              characters: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    translatedName: { type: Type.STRING },
                    speechStyle: { type: Type.STRING },
                    relations: { type: Type.STRING },
                  },
                  required: ['name', 'translatedName'],
                },
              },
              locations: { type: Type.ARRAY, items: { type: Type.STRING } },
              loreTerms: { type: Type.ARRAY, items: { type: Type.STRING } },
              relationships: { type: Type.ARRAY, items: { type: Type.STRING } },
              keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
              translationDecisions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    original: { type: Type.STRING },
                    translated: { type: Type.STRING },
                    context: { type: Type.STRING },
                  },
                  required: ['original', 'translated'],
                },
              },
              summaryAddition: { type: Type.STRING },
            },
          },
        },
        required: ['translations'],
      },
    },
      }),
  });

  return JSON.parse((response.text || '{"translations":[]}').trim());
}

export async function retranslateSingleBubble(
  targetRegion: TextRegion,
  siblingRegions: TextRegion[],
  project: Project,
  glossary: GlossaryEntry[],
  style: TranslationStyle,
  targetLanguage: string,
  settings: AiSettings,
  customInstruction?: string
): Promise<{ translatedText: string; alternatives: string[] }> {
  const ai = getAiClient(undefined, settings?.providers?.gemini?.endpointUrl);
  const primaryModel = normalizeGeminiModel(settings.translationModel);

  const contextLines = siblingRegions
    .map(
      (r) =>
        `[#${r.readingOrder} ${r.id === targetRegion.id ? 'TARGET' : r.regionType}${r.speaker ? ` (${r.speaker})` : ''}] ${r.originalText} => ${r.translatedText || '(untranslated)'}`
    )
    .join('\n');

  const systemInstruction = buildComicTranslationInstruction({
    project,
    storyMemory: project.storyMemory,
    glossary,
    style,
    targetLanguage,
    regionsText: targetRegion.originalText,
  });

  const { result: response } = await executeWithGeminiResilience({
    primaryModel,
    operationName: 'retranslateSingleBubble',
    run: async (model) =>
      ai.models.generateContent({
        model,
        contents: `Page Context:\n${contextLines}\n\nTarget Bubble Geometry: width=${Math.round(targetRegion.boundingBox.width)}/1000, height=${Math.round(targetRegion.boundingBox.height)}/1000\n${customInstruction ? `User instruction: ${customInstruction}\n` : ''}Retranslate ONLY the TARGET bubble ("${targetRegion.originalText}") into ${targetLanguage} and provide 3 diverse, natural comic-grade alternatives.`,
        config: {
          systemInstruction,
          thinkingConfig: buildThinkingConfigForModel(model),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          translatedText: { type: Type.STRING },
          alternatives: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['translatedText', 'alternatives'],
      },
    },
      }),
  });

  return JSON.parse((response.text || '{"translatedText":"","alternatives":[]}').trim());
}
