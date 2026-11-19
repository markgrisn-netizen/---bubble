import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  AiSettings,
  Chapter,
  GlossaryEntry,
  GlossarySuggestion,
  OperationLog,
  Page,
  Project,
  TextRegion,
  TranslationJob,
  UserProfile,
} from '../src/types/domain.ts';
import { createDefaultFontSettings } from '../src/utils/bubbleLayout.ts';
import { DEFAULT_AI_SETTINGS, normalizeAiSettings } from './aiProviders.ts';
import { redactSecrets } from './secretVault.ts';

export interface DatabaseState {
  user: UserProfile;
  projects: Project[];
  chapters: Chapter[];
  pages: Page[];
  glossary: GlossaryEntry[];
  glossarySuggestions: GlossarySuggestion[];
  jobs: TranslationJob[];
  logs: OperationLog[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
const DB_FILE = path.resolve(DATA_DIR, 'db.json');

export function ensureDataDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function getUploadsDir(): string {
  ensureDataDirs();
  return UPLOADS_DIR;
}

export function saveBase64Asset(dataUrl: string, prefix = 'page'): { url: string; filePath: string } {
  ensureDataDirs();
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  let ext = 'png';
  let base64 = dataUrl;
  if (match) {
    const mime = match[1];
    base64 = match[2];
    if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else if (mime.includes('webp')) ext = 'webp';
  }
  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { url: `/uploads/${filename}`, filePath };
}

function makeRegion(
  pageId: string,
  opts: {
    id: string;
    regionType: TextRegion['regionType'];
    x: number;
    y: number;
    width: number;
    height: number;
    originalText: string;
    translatedText: string;
    alternatives: string[];
    sourceLanguage: string;
    confidence: number;
    readingOrder: number;
    speaker?: string;
    sfxMode?: TextRegion['sfxMode'];
    cleanMode?: TextRegion['cleanMode'];
    color?: string;
    fontSize?: number;
  }
): TextRegion {
  const fontSettings = createDefaultFontSettings('ar', opts.regionType);
  if (opts.color) fontSettings.color = opts.color;
  if (opts.fontSize) fontSettings.fontSize = opts.fontSize;
  return {
    id: opts.id,
    pageId,
    regionType: opts.regionType,
    boundingBox: { x: opts.x, y: opts.y, width: opts.width, height: opts.height },
    boundingPolygon: [
      { x: opts.x, y: opts.y },
      { x: opts.x + opts.width, y: opts.y },
      { x: opts.x + opts.width, y: opts.y + opts.height },
      { x: opts.x, y: opts.y + opts.height },
    ],
    originalText: opts.originalText,
    translatedText: opts.translatedText,
    alternatives: opts.alternatives,
    sourceLanguage: opts.sourceLanguage,
    confidence: opts.confidence,
    readingOrder: opts.readingOrder,
    speaker: opts.speaker,
    fontSettings,
    cleanMode: opts.cleanMode ?? 'auto',
    sfxMode: opts.sfxMode ?? (opts.regionType === 'sfx' ? 'side' : 'keep'),
    approvalStatus: 'approved',
    translationStatus: 'translated',
  };
}

function buildSeedState(): DatabaseState {
  const now = new Date().toISOString();

  // Primary flagship project: Western Superhero Comics (EN -> AR)
  const apexProjectId = 'proj-apex-vanguard';
  const apexCh1Id = 'ch-apex-1';
  const apexPage1Id = 'page-av-1';

  // Secondary project: Manga / Webtoon reference
  const projectId = 'proj-silent-dawn';
  const ch1Id = 'ch-silent-dawn-1';
  const ch2Id = 'ch-silent-dawn-2';

  const defaultSettings: AiSettings = normalizeAiSettings(DEFAULT_AI_SETTINGS);

  const p1Id = 'page-sd-1';
  const p2Id = 'page-sd-2';
  const p3Id = 'page-sd-3';

  return {
    user: {
      id: 'user-studio-1',
      email: 'studio@paneltranslate.local',
      settings: defaultSettings,
      createdAt: now,
    },
    projects: [
      {
        id: apexProjectId,
        userId: 'user-studio-1',
        title: 'طليعة القمة — Apex Vanguard',
        comicFormat: 'superhero',
        coverImage: '/src/assets/images/western_superhero_cover_1794852321934.jpg',
        sourceLanguage: 'en',
        targetLanguage: 'ar',
        readingDirection: 'ltr',
        translationStyle: 'cinematic',
        storyMemory: {
          characters: [
            {
              id: 'char-av-1',
              name: 'Sentinel',
              translatedName: 'سينتينيل',
              speechStyle: 'نبرة بطولية حازمة واثقة ومقتضبة في قلب المعركة',
              relations: 'حامية نيو مترو وقائدة طليعة القمة',
            },
            {
              id: 'char-av-2',
              name: 'Commander Vance',
              translatedName: 'القائد فانس',
              speechStyle: 'أسلوب عسكري صارم ومباشر أثناء الأزمات',
              relations: 'قائد عمليات الدفاع في نيو مترو',
            },
          ],
          locations: ['New Metro / نيو مترو', 'Quantum Reactor Grid / شبكة المفاعل الكمومي'],
          recurringNotes:
            'فصحى سينمائية احترافية لكوميكس الأبطال الخارقين مع الحفاظ على أسماء الأبطال والمصطلحات التقنية والعسكرية.',
          chapterSummaries: [
            'تتعرض شبكة الطاقة في نيو مترو لهجوم خاطف فجراً وتواجه سينتينيل النيران بدرعها الطاقي.',
          ],
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: projectId,
        userId: 'user-studio-1',
        title: 'سجلات الفجر الصامت — Silent Dawn',
        comicFormat: 'manga',
        coverImage: '/src/assets/images/manga_cover_silent_dawn_1794847947377.jpg',
        sourceLanguage: 'ja',
        targetLanguage: 'ar',
        readingDirection: 'rtl',
        translationStyle: 'natural_pro',
        storyMemory: {
          characters: [
            {
              id: 'char-1',
              name: 'Kenji',
              translatedName: 'كينجي',
              speechStyle: 'هادئ وحازم، يستخدم عبارات قصيرة ومتزنة',
              relations: 'الساموراي المسافر الباحث عن معبد الجبل',
            },
            {
              id: 'char-2',
              name: 'Ren',
              translatedName: 'رين',
              speechStyle: 'مندفع وقوي النبرة أثناء القتال',
              relations: 'حليف كينجي ومبارز الكاتانا',
            },
          ],
          locations: ['معبد الجبل البعيد', 'جسر الضباب'],
          recurringNotes: 'حافظ على الطابع الملحمي الرصين وتجنب العامية.',
          chapterSummaries: ['وصل كينجي إلى مشارف الجبل وهو يعزم على إكمال تدريبه رغم المشقة.'],
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    chapters: [
      {
        id: apexCh1Id,
        projectId: apexProjectId,
        title: 'العدد #01: بروتوكول الأفق — Issue #01',
        chapterNumber: 1,
        pageCount: 1,
        status: 'completed',
        lastReadPage: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ch1Id,
        projectId,
        title: 'الفصل 01: طريق المعبد',
        chapterNumber: 1,
        pageCount: 2,
        status: 'completed',
        lastReadPage: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ch2Id,
        projectId,
        title: 'الفصل 02: أضواء الشفق (ويب تون)',
        chapterNumber: 2,
        pageCount: 1,
        status: 'partial',
        lastReadPage: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    pages: [
      {
        id: apexPage1Id,
        chapterId: apexCh1Id,
        pageNumber: 1,
        originalImage: '/src/assets/images/western_superhero_page_1794852323898.jpg',
        status: 'completed',
        width: 896,
        height: 1200,
        rotation: 0,
        manualStrokes: [],
        panels: [
          { id: 'panel-av-1', box: { x: 28, y: 24, width: 944, height: 356 }, readingOrder: 1 },
          { id: 'panel-av-2', box: { x: 28, y: 394, width: 944, height: 234 }, readingOrder: 2 },
          { id: 'panel-av-3', box: { x: 28, y: 642, width: 944, height: 334 }, readingOrder: 3 },
        ],
        regions: [
          makeRegion(apexPage1Id, {
            id: 'reg-av-1',
            regionType: 'narration',
            x: 50,
            y: 38,
            width: 319,
            height: 32,
            originalText: 'NEW METRO — 02:14 AM',
            translatedText: 'نيو مترو — 02:14 فجراً',
            alternatives: ['مدينة نيو مترو — الساعة 02:14 فجراً', 'نيو مترو — الثانية والربع فجراً'],
            sourceLanguage: 'en',
            confidence: 0.99,
            readingOrder: 1,
            fontSize: 16,
          }),
          makeRegion(apexPage1Id, {
            id: 'reg-av-2',
            regionType: 'dialogue',
            x: 82,
            y: 90,
            width: 212,
            height: 70,
            originalText: 'THE GRID IS FAILING!',
            translatedText: 'شبكة الطاقة تنهار!',
            alternatives: ['الشبكة توشك على الانهيار!', 'نظام الطاقة يتهاوى!'],
            sourceLanguage: 'en',
            confidence: 0.98,
            readingOrder: 2,
            speaker: 'Sentinel',
            fontSize: 17,
          }),
          makeRegion(apexPage1Id, {
            id: 'reg-av-3',
            regionType: 'dialogue',
            x: 116,
            y: 420,
            width: 212,
            height: 88,
            originalText: 'HOLD THE LINE, SENTINEL!',
            translatedText: 'اثبتي في موقعكِ يا سينتينيل!',
            alternatives: ['تمسّكي بخط الدفاع يا سينتينيل!', 'لا تتراجعي يا سينتينيل!'],
            sourceLanguage: 'en',
            confidence: 0.98,
            readingOrder: 3,
            speaker: 'Commander Vance',
            fontSize: 17,
          }),
          makeRegion(apexPage1Id, {
            id: 'reg-av-4',
            regionType: 'sfx',
            x: 615,
            y: 515,
            width: 295,
            height: 125,
            originalText: 'KRAAK!',
            translatedText: 'كرااااك!',
            alternatives: ['دويّ!', 'انفجار!'],
            sourceLanguage: 'en',
            confidence: 0.95,
            readingOrder: 4,
            sfxMode: 'keep',
            cleanMode: 'keep',
            color: '#DC2626',
            fontSize: 22,
          }),
          makeRegion(apexPage1Id, {
            id: 'reg-av-5',
            regionType: 'dialogue',
            x: 58,
            y: 646,
            width: 232,
            height: 108,
            originalText: 'NOT ON MY WATCH.',
            translatedText: 'ليس ما دمتُ هنا.',
            alternatives: ['لن يحدث ذلك بوجودي.', 'محال وأنا على قيد الحياة.'],
            sourceLanguage: 'en',
            confidence: 0.98,
            readingOrder: 5,
            speaker: 'Sentinel',
            color: '#FFFFFF',
            fontSize: 17,
          }),
        ],
      },
      {
        id: p1Id,
        chapterId: ch1Id,
        pageNumber: 1,
        originalImage: '/src/assets/images/manga_sample_page_one_1794847946828.jpg',
        status: 'completed',
        width: 896,
        height: 1200,
        rotation: 0,
        manualStrokes: [],
        panels: [
          { id: 'panel-1a', box: { x: 100, y: 40, width: 800, height: 510 }, readingOrder: 1 },
          { id: 'panel-1b', box: { x: 100, y: 580, width: 800, height: 370 }, readingOrder: 2 },
        ],
        regions: [
          makeRegion(p1Id, {
            id: 'reg-p1-1',
            regionType: 'dialogue',
            x: 690,
            y: 52,
            width: 200,
            height: 220,
            originalText: 'あそこか…遠いな。',
            translatedText: 'أهناك... يبدو بعيداً جداً.',
            alternatives: [
              'أهو ذاك المكان... إنه بعيد للغاية.',
              'ذلك المعبد هناك... الطريق طويل.',
              'أهناك؟ يبدو أبعد مما تصورت.',
            ],
            sourceLanguage: 'ja',
            confidence: 0.97,
            readingOrder: 1,
            speaker: 'Kenji',
            fontSize: 19,
          }),
          makeRegion(p1Id, {
            id: 'reg-p1-2',
            regionType: 'dialogue',
            x: 100,
            y: 296,
            width: 176,
            height: 218,
            originalText: 'でも、行くしかない。',
            translatedText: 'لكن لا مفر من المضي قدماً.',
            alternatives: [
              'ومع ذلك، عليّ أن أذهب.',
              'لا خيار أمامي سوى المتابعة.',
              'رغم ذلك، سأواصل المسير.',
            ],
            sourceLanguage: 'ja',
            confidence: 0.96,
            readingOrder: 2,
            speaker: 'Kenji',
            fontSize: 18,
          }),
          makeRegion(p1Id, {
            id: 'reg-p1-3',
            regionType: 'dialogue',
            x: 680,
            y: 596,
            width: 200,
            height: 208,
            originalText: '待っていろ…。',
            translatedText: 'انتظرني...',
            alternatives: ['تمهل قليلاً...', 'ابقَ في انتظارنا...', 'انتظر وصولي...'],
            sourceLanguage: 'ja',
            confidence: 0.98,
            readingOrder: 3,
            speaker: 'Kenji',
            fontSize: 20,
          }),
          makeRegion(p1Id, {
            id: 'reg-p1-4',
            regionType: 'dialogue',
            x: 120,
            y: 676,
            width: 196,
            height: 222,
            originalText: '修行の道は始まったばかりだ。',
            translatedText: 'طريق التدريب لم يبدأ سوى للتو.',
            alternatives: [
              'مسيرة الصقل والتدريب ما زالت في بدايتها.',
              'ما هذه إلا الخطوة الأولى في طريق التدريب.',
              'رحلة التدريب بدأت لتوها فقط.',
            ],
            sourceLanguage: 'ja',
            confidence: 0.95,
            readingOrder: 4,
            speaker: 'Kenji',
            fontSize: 17,
          }),
          makeRegion(p1Id, {
            id: 'reg-p1-5',
            regionType: 'sfx',
            x: 185,
            y: 215,
            width: 90,
            height: 75,
            originalText: 'サァ',
            translatedText: 'حفيف',
            alternatives: ['نسيم', 'همس الريح'],
            sourceLanguage: 'ja',
            confidence: 0.89,
            readingOrder: 5,
            sfxMode: 'keep',
            cleanMode: 'keep',
            color: '#DC2626',
            fontSize: 16,
          }),
        ],
      },
      {
        id: p2Id,
        chapterId: ch1Id,
        pageNumber: 2,
        originalImage: '/src/assets/images/manga_sample_page_two_1794847947045.jpg',
        status: 'completed',
        width: 896,
        height: 1200,
        rotation: 0,
        manualStrokes: [],
        panels: [
          { id: 'panel-2a', box: { x: 20, y: 20, width: 650, height: 320 }, readingOrder: 1 },
          { id: 'panel-2b', box: { x: 20, y: 210, width: 950, height: 610 }, readingOrder: 2 },
        ],
        regions: [
          makeRegion(p2Id, {
            id: 'reg-p2-1',
            regionType: 'dialogue',
            x: 730,
            y: 38,
            width: 200,
            height: 316,
            originalText: 'うおおおッ!!',
            translatedText: 'هاااااه!!',
            alternatives: ['تباً، إليك هذا!!', 'استعد الآن!!', 'هيااا!!'],
            sourceLanguage: 'ja',
            confidence: 0.94,
            readingOrder: 1,
            speaker: 'Ren',
            fontSize: 22,
          }),
          makeRegion(p2Id, {
            id: 'reg-p2-2',
            regionType: 'dialogue',
            x: 180,
            y: 416,
            width: 180,
            height: 232,
            originalText: 'ここだッ!!',
            translatedText: 'هذه لحظتي!!',
            alternatives: ['الآن حان الوقت!!', 'هنا تماماً!!', 'تلقَّ هذه!!'],
            sourceLanguage: 'ja',
            confidence: 0.96,
            readingOrder: 2,
            speaker: 'Ren',
            fontSize: 20,
          }),
          makeRegion(p2Id, {
            id: 'reg-p2-3',
            regionType: 'narration',
            x: 726,
            y: 676,
            width: 228,
            height: 118,
            originalText: '一瞬の静寂、そして――。',
            translatedText: 'لحظة سكون مطبق، ثم—',
            alternatives: ['صمت خاطف، وبعدها—', 'ساد السكون للحظة، ثم—'],
            sourceLanguage: 'ja',
            confidence: 0.95,
            readingOrder: 3,
            fontSize: 16,
          }),
          makeRegion(p2Id, {
            id: 'reg-p2-4',
            regionType: 'sfx',
            x: 515,
            y: 840,
            width: 185,
            height: 105,
            originalText: 'シャキーン! SHING!',
            translatedText: 'رنين السيف!',
            alternatives: ['صليل النصل!', 'تشيينغ!'],
            sourceLanguage: 'ja',
            confidence: 0.91,
            readingOrder: 4,
            sfxMode: 'side',
            cleanMode: 'keep',
            color: '#DC2626',
            fontSize: 17,
          }),
        ],
      },
      {
        id: p3Id,
        chapterId: ch2Id,
        pageNumber: 1,
        originalImage: '/src/assets/images/manhwa_sample_page_three_1794847948010.jpg',
        status: 'analyzed',
        width: 896,
        height: 1200,
        rotation: 0,
        manualStrokes: [],
        panels: [{ id: 'panel-3a', box: { x: 0, y: 0, width: 1000, height: 1000 }, readingOrder: 1 }],
        regions: [
          makeRegion(p3Id, {
            id: 'reg-p3-1',
            regionType: 'dialogue',
            x: 545,
            y: 58,
            width: 336,
            height: 212,
            originalText: 'The magic pulses stronger as night falls...',
            translatedText: 'يزداد نبض السحر قوةً مع حلول الليل...',
            alternatives: [
              'يشتد خفقان السحر كلما خيّم الظلام...',
              'طاقة السحر تتعاظم مع هبوط الليل...',
            ],
            sourceLanguage: 'en',
            confidence: 0.99,
            readingOrder: 1,
            speaker: 'Aiden',
            fontSize: 20,
          }),
          makeRegion(p3Id, {
            id: 'reg-p3-2',
            regionType: 'sfx',
            x: 425,
            y: 740,
            width: 120,
            height: 60,
            originalText: '스턱..',
            translatedText: 'خطوة...',
            alternatives: ['توقف...', 'وقع قدم...'],
            sourceLanguage: 'ko',
            confidence: 0.87,
            readingOrder: 2,
            sfxMode: 'side',
            cleanMode: 'keep',
            color: '#E11D48',
            fontSize: 16,
          }),
        ],
      },
    ],
    glossary: [
      {
        id: 'gloss-av-1',
        projectId: apexProjectId,
        originalTerm: 'Sentinel',
        translatedTerm: 'سينتينيل',
        category: 'character',
        notes: 'البطلة الرئيسية في سلسلة Apex Vanguard',
      },
      {
        id: 'gloss-av-2',
        projectId: apexProjectId,
        originalTerm: 'Commander Vance',
        translatedTerm: 'القائد فانس',
        category: 'title',
        notes: 'قائد وحدة التدخل السريع في نيو مترو',
      },
      {
        id: 'gloss-av-3',
        projectId: apexProjectId,
        originalTerm: 'Apex Vanguard',
        translatedTerm: 'طليعة القمة',
        category: 'team',
        notes: 'الفريق الرئيسي للأبطال الخارقين',
      },
      {
        id: 'gloss-av-4',
        projectId: apexProjectId,
        originalTerm: 'Kinetic Barrier',
        translatedTerm: 'الحاجز الحركي',
        category: 'power',
        notes: 'القوة الدفاعية الأساسية لسينتينيل',
      },
      {
        id: 'gloss-av-5',
        projectId: apexProjectId,
        originalTerm: 'New Metro',
        translatedTerm: 'نيو مترو',
        category: 'place',
        notes: 'المدينة الرئيسية للأحداث',
      },
      {
        id: 'gloss-av-6',
        projectId: apexProjectId,
        originalTerm: 'Skyline Protocol',
        translatedTerm: 'بروتوكول الأفق',
        category: 'military',
        notes: 'خطة الطوارئ الدفاعية العليا',
      },
      {
        id: 'gloss-av-7',
        projectId: apexProjectId,
        originalTerm: 'Quantum Reactor',
        translatedTerm: 'المفاعل الكمومي',
        category: 'scientific',
        notes: 'مصدر الطاقة المغذي لشبكة المدينة',
      },
      {
        id: 'gloss-av-8',
        projectId: apexProjectId,
        originalTerm: 'KRAAK!',
        translatedTerm: 'كرااااك!',
        category: 'sfx',
        notes: 'مؤثر صوتي للانفجار والاصطدام الطاقي',
      },
      {
        id: 'gloss-1',
        projectId,
        originalTerm: 'Kenji',
        translatedTerm: 'كينجي',
        category: 'character',
        notes: 'البطل الرئيسي في رحلة المعبد',
      },
      {
        id: 'gloss-2',
        projectId,
        originalTerm: 'Wismerhill',
        translatedTerm: 'ويسميرهيل',
        category: 'character',
        notes: 'مصطلح مرجعي معتمد لا يتغير عبر الفصول',
      },
      {
        id: 'gloss-3',
        projectId,
        originalTerm: '修行の道',
        translatedTerm: 'طريق الصقل والتدريب',
        category: 'term',
        notes: 'المسار الروحي والقتالي للساموراي',
      },
    ],
    glossarySuggestions: [],
    jobs: [],
    logs: [
      {
        id: 'log-init-1',
        timestamp: now,
        level: 'info',
        action: 'SYSTEM_READY',
        message:
          'فُقّاعة — Faqqa initialized with multi-provider Comic/Manga translation pipeline.',
      },
    ],
  };
}

let cachedDb: DatabaseState | null = null;

const LEGACY_SEED_BOXES: Record<string, { oldX: number; box: { x: number; y: number; width: number; height: number } }> = {
  'reg-av-1': { oldX: 56, box: { x: 50, y: 38, width: 319, height: 32 } },
  'reg-av-2': { oldX: 96, box: { x: 82, y: 90, width: 212, height: 70 } },
  'reg-av-3': { oldX: 118, box: { x: 116, y: 420, width: 212, height: 88 } },
  'reg-av-5': { oldX: 86, box: { x: 58, y: 646, width: 232, height: 108 } },
  'reg-p1-1': { oldX: 740, box: { x: 690, y: 52, width: 200, height: 220 } },
  'reg-p1-2': { oldX: 132, box: { x: 100, y: 296, width: 176, height: 218 } },
  'reg-p1-3': { oldX: 726, box: { x: 680, y: 596, width: 200, height: 208 } },
  'reg-p1-4': { oldX: 154, box: { x: 120, y: 676, width: 196, height: 222 } },
  'reg-p2-1': { oldX: 775, box: { x: 730, y: 38, width: 200, height: 316 } },
  'reg-p2-2': { oldX: 205, box: { x: 180, y: 416, width: 180, height: 232 } },
  'reg-p2-3': { oldX: 755, box: { x: 726, y: 676, width: 228, height: 118 } },
  'reg-p3-1': { oldX: 540, box: { x: 545, y: 58, width: 336, height: 212 } },
};

function syncUntouchedSeedRegions(db: DatabaseState): boolean {
  let changed = false;
  for (const page of db.pages || []) {
    if (
      (page.id === 'page-sd-1' || page.id === 'page-sd-2' || page.id === 'page-sd-3') &&
      page.width === 900 &&
      page.height === 1200
    ) {
      page.width = 896;
      changed = true;
    }
    for (const reg of page.regions || []) {
      const target = LEGACY_SEED_BOXES[reg.id];
      if (target && Math.round(reg.boundingBox.x) === target.oldX) {
        reg.boundingBox = { ...target.box };
        reg.boundingPolygon = [
          { x: target.box.x, y: target.box.y },
          { x: target.box.x + target.box.width, y: target.box.y },
          { x: target.box.x + target.box.width, y: target.box.y + target.box.height },
          { x: target.box.x, y: target.box.y + target.box.height },
        ];
        changed = true;
      }
    }
  }
  return changed;
}

export function getDb(): DatabaseState {
  ensureDataDirs();
  if (cachedDb) return cachedDb;
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      cachedDb = JSON.parse(raw) as DatabaseState;
      if (cachedDb?.user) {
        cachedDb.user.settings = normalizeAiSettings(cachedDb.user.settings);
      }
      if (cachedDb && !Array.isArray(cachedDb.glossarySuggestions)) {
        cachedDb.glossarySuggestions = [];
      }
      if (cachedDb && syncUntouchedSeedRegions(cachedDb)) {
        saveDb();
      }
      return cachedDb;
    } catch {
      // Fallback to fresh seed if corrupted
    }
  }
  cachedDb = buildSeedState();
  saveDb();
  return cachedDb;
}

export function saveDb(): void {
  ensureDataDirs();
  if (!cachedDb) return;
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(cachedDb, null, 2), 'utf-8');
  fs.renameSync(tmpFile, DB_FILE);
}

export function appendLog(
  level: OperationLog['level'],
  action: string,
  message: string,
  meta?: { projectId?: string; chapterId?: string; pageId?: string }
): void {
  const db = getDb();
  db.logs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    level,
    action,
    message: redactSecrets(message),
    ...meta,
  });
  if (db.logs.length > 200) db.logs.length = 200;
  saveDb();
}
