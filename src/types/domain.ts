export type LanguageCode = 'ar' | 'en';
export type ThemeMode = 'light' | 'dark';

export type ReadingDirection = 'ltr' | 'rtl' | 'vertical';
export type ComicFormat =
  | 'superhero'
  | 'american'
  | 'british'
  | 'european'
  | 'graphic_novel'
  | 'indie'
  | 'manga'
  | 'manhwa'
  | 'manhua'
  | 'webtoon'
  | 'comic';
export type RegionType = 'dialogue' | 'narration' | 'sfx' | 'outside';
export type CleanMode = 'auto' | 'manual' | 'keep';
export type SfxMode = 'keep' | 'side' | 'replace' | 'artistic' | 'ignore';
export type ApprovalStatus = 'pending' | 'approved' | 'needs_review' | 'rejected';

export type TranslationStyle =
  | 'natural_pro'
  | 'faithful'
  | 'cinematic'
  | 'literary'
  | 'simplified'
  | 'literal'
  | 'character_voice';

export interface Point {
  x: number; // Normalized 0..1000
  y: number; // Normalized 0..1000
}

export interface BoundingBox {
  x: number; // Normalized 0..1000
  y: number; // Normalized 0..1000
  width: number; // Normalized 0..1000
  height: number; // Normalized 0..1000
}

export interface FontSettings {
  fontFamily: string;
  fontSize: number; // Relative to 1000px page width baseline
  fontWeight: '400' | '600' | '700' | '800';
  color: string;
  strokeColor?: string;
  strokeWidth?: number;
  align: 'center' | 'right' | 'left';
  lineHeight: number;
  padding: number; // Normalized 0..50
  rotation: number; // Degrees -45..45
  direction: 'rtl' | 'ltr' | 'vertical';
  autoFit: boolean;
  offsetX: number; // Normalized -100..100
  offsetY: number; // Normalized -100..100
  letterCase?: 'normal' | 'uppercase';
}

export interface ManualStroke {
  id: string;
  tool: 'brush' | 'eraser';
  size: number; // Normalized 0..100
  color?: string;
  points: Point[];
}

export interface TextRegion {
  id: string;
  pageId: string;
  regionType: RegionType;
  boundingBox: BoundingBox;
  boundingPolygon: Point[];
  originalText: string;
  translatedText: string;
  alternatives: string[];
  sourceLanguage: string;
  confidence: number; // 0..1
  readingOrder: number;
  speaker?: string;
  fontSettings: FontSettings;
  cleanMode: CleanMode;
  sfxMode: SfxMode;
  approvalStatus: ApprovalStatus;
  translationStatus: 'untranslated' | 'translated' | 'edited' | 'error';
}

export interface DetectedPanel {
  id: string;
  box: BoundingBox;
  readingOrder: number;
}

export type PageStatus =
  | 'pending'
  | 'analyzing'
  | 'analyzed'
  | 'translating'
  | 'cleaned'
  | 'completed'
  | 'error';

export interface PageTranslationMeta {
  providerUsed: AiProviderId;
  modelUsed: string;
  visionProviderUsed?: AiProviderId;
  visionModelUsed?: string;
  fallbackUsed?: boolean;
  updatedAt: string;
}

export interface Page {
  id: string;
  chapterId: string;
  pageNumber: number;
  originalImage: string; // URL or Data URL (immutable)
  processedImage?: string; // Optional cached composite
  status: PageStatus;
  errorMessage?: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  contentHash?: string;
  manualStrokes: ManualStroke[];
  panels: DetectedPanel[];
  regions: TextRegion[];
  lastTranslationMeta?: PageTranslationMeta;
}

export interface CharacterMemory {
  id: string;
  name: string;
  translatedName: string;
  speechStyle: string;
  relations: string;
}

export interface TranslationDecisionMemory {
  original: string;
  translated: string;
  context?: string;
}

export interface StoryMemory {
  characters: CharacterMemory[];
  locations: string[];
  loreTerms?: string[];
  relationships?: string[];
  keyFacts?: string[];
  translationDecisions?: TranslationDecisionMemory[];
  recurringNotes: string;
  chapterSummaries: string[];
}

export type GlossaryCategory =
  | 'character'
  | 'title'
  | 'team'
  | 'power'
  | 'ability'
  | 'place'
  | 'military'
  | 'scientific'
  | 'fantasy'
  | 'sfx'
  | 'term';

export interface GlossaryEntry {
  id: string;
  projectId: string;
  originalTerm: string;
  translatedTerm: string;
  category: GlossaryCategory;
  notes: string;
}

export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  chapterNumber: number;
  pageCount: number;
  status: 'draft' | 'processing' | 'completed' | 'partial';
  lastReadPage: number;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  title: string;
  comicFormat: ComicFormat;
  coverImage?: string;
  sourceLanguage: string;
  targetLanguage: string;
  readingDirection: ReadingDirection;
  translationStyle: TranslationStyle;
  storyMemory: StoryMemory;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithDetails extends Project {
  chapters: Chapter[];
  glossaryCount: number;
  completionPercent: number;
}

export interface TranslationJob {
  id: string;
  projectId: string;
  chapterId: string;
  chapterTitle: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  totalPages: number;
  completedPages: number;
  failedPages: number;
  progress: number; // 0..100
  batchSize?: number;
  currentBatch?: number;
  totalBatches?: number;
  currentPageNumber?: number;
  activeProvider?: AiProviderId;
  activeModel?: string;
  selectedPageIds?: string[];
  forceRetranslate?: boolean;
  pageStates: Record<string, 'queued' | 'running' | 'completed' | 'failed' | 'skipped'>;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export type AiProviderId =
  | 'gemini'
  | 'groq'
  | 'openrouter'
  | 'cloudflare'
  | 'deepseek'
  | 'qwen_studio';

export interface ProviderModelMeta {
  id: string;
  label: string;
  supportsVision: boolean;
  isFree: boolean;
  tier: 'free' | 'paid' | 'freemium';
  pricingNoteAr?: string;
  pricingNoteEn?: string;
}

export interface ProviderCatalogInfo {
  id: AiProviderId;
  name: string;
  subtitleAr: string;
  subtitleEn: string;
  apiKeyUrl: string;
  docsUrl: string;
  defaultEndpointUrl: string;
  supportsVision: boolean;
  supportsDynamicModels: boolean;
  requiresAccountId: boolean;
  freeTierAr: string;
  freeTierEn: string;
  secretEnvVar: string;
  defaultTranslationModel: string;
  defaultVisionModel?: string;
  models: ProviderModelMeta[];
}

export interface ProviderEndpointConfig {
  translationModel: string;
  visionModel?: string;
  endpointUrl: string;
  accountId?: string;
}

export type ProvidersStatusMap = Record<AiProviderId, boolean>;

export interface ProviderSecretStatusDetail {
  configured: boolean;
  source: 'vault' | 'env' | 'none';
  maskedHint?: string;
  hasAccountId?: boolean;
  accountIdHint?: string;
}

export type ProvidersDetailedStatusMap = Record<AiProviderId, ProviderSecretStatusDetail>;

export interface ProviderTestResult {
  ok: boolean;
  provider: AiProviderId;
  model: string;
  visionModel?: string;
  translationVerified: boolean;
  visionVerified?: boolean;
  latencyMs: number;
  message: string;
  visionMessage?: string;
  fallbackUsed?: boolean;
  errorCode?: string;
}

export interface AiSettings {
  provider: AiProviderId | 'openai_compatible' | 'anthropic_compatible' | 'local';
  visionProvider?: AiProviderId;
  translationModel: string;
  visionOcrModel: string;
  inpaintingEngine: 'telea_biharmonic' | 'solid_interior' | 'manual_only';
  creativity: number; // 0..1
  fidelity: number; // 0..1
  parallelPages: number; // 1..4
  rateLimitPerMinute: number;
  customEndpointUrl?: string;
  autoFallback?: boolean;
  allowPaidFallback?: boolean;
  fallbackOrder?: AiProviderId[];
  providers?: Record<AiProviderId, ProviderEndpointConfig>;
}

export interface OperationLog {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  message: string;
  projectId?: string;
  chapterId?: string;
  pageId?: string;
}

export interface UserProfile {
  id: string;
  email: string;
  settings: AiSettings;
  createdAt: string;
}

export type BrowserPrivacyMode = 'standard' | 'incognito';

export type BrowserProtectionStatus =
  | 'clear'
  | 'cloudflare_challenge'
  | 'captcha_challenge'
  | 'login_wall'
  | 'http_403_blocked';

export interface BrowserChapterLink {
  label: string;
  url: string;
  kind: 'prev' | 'next' | 'chapter';
}

export interface BrowserDiscoveredImage {
  id: string;
  index: number;
  url: string;
  dataUrl: string;
  width: number;
  height: number;
  mimeType: string;
  byteSize: number;
  sha256: string;
  captureSource: 'dom_image' | 'canvas_capture' | 'network_cache' | 'screenshot_fallback';
  isDuplicate: boolean;
  duplicateOfIndex?: number;
  selected: boolean;
}

export interface BrowserTabSnapshot {
  id: string;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  httpStatus: number | null;
  protectionStatus: BrowserProtectionStatus;
  protectionMessage?: string;
  scrollY: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  screenshotDataUrl: string;
  discoveredImageCount: number;
  chapterLinks: BrowserChapterLink[];
  focusedInput?: { tag: string; type: string; placeholder?: string } | null;
  privacyMode: BrowserPrivacyMode;
  error?: string;
}

export interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

export interface BrowserHistoryEntry {
  id: string;
  title: string;
  url: string;
  visitedAt: string;
}

export interface BrowserCapabilities {
  environment: 'ai_studio_web' | 'desktop' | 'android';
  iframeSupported: false;
  iframeReason: string;
  serverChromiumAvailable: boolean;
  chromiumExecutablePath?: string;
  androidModuleAvailable: boolean;
  androidModulePath: string;
  shareIntentSupported: boolean;
}

