import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Languages,
  Loader2,
  PlugZap,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AiProviderId,
  AiSettings,
  LanguageCode,
  ProviderCatalogInfo,
  ProviderEndpointConfig,
  ProviderModelMeta,
  ProvidersDetailedStatusMap,
  ProvidersStatusMap,
  ProviderTestResult,
  ThemeMode,
} from '../types/domain';
import { tFor } from '../i18n/translations';
import { api } from '../utils/api';
import { ProviderLogo } from './ProviderLogos';

interface SettingsViewProps {
  lang: LanguageCode;
  theme: ThemeMode;
  settings: AiSettings;
  serverConfigured: boolean;
  providersStatus: ProvidersStatusMap;
  providersDetailed?: ProvidersDetailedStatusMap;
  availableFonts: string[];
  onChangeLang: (lang: LanguageCode) => void;
  onChangeTheme: (theme: ThemeMode) => void;
  onSettingsUpdated: (
    next: AiSettings,
    status?: ProvidersStatusMap,
    detailed?: ProvidersDetailedStatusMap
  ) => void;
  onFontAdded: (fontName: string) => void;
}

const ALL_PROVIDER_IDS: AiProviderId[] = [
  'gemini',
  'groq',
  'openrouter',
  'cloudflare',
  'deepseek',
  'qwen_studio',
];

const FALLBACK_CATALOG: ProviderCatalogInfo[] = [
  {
    id: 'gemini',
    name: 'Google Gemini API',
    subtitleAr: 'الرؤية متعددة الوسائط OCR وترجمة السياق الكامل للفقاعات',
    subtitleEn: 'Multimodal Vision OCR & Context-Aware Comic Translation',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    defaultEndpointUrl: 'https://generativelanguage.googleapis.com',
    supportsVision: true,
    supportsDynamicModels: true,
    requiresAccountId: false,
    freeTierAr: 'حصة مجانية متوفرة عبر Google AI Studio (بحدود طلبات يومية)',
    freeTierEn: 'Free tier available in Google AI Studio (RPM/RPD limits apply)',
    secretEnvVar: 'GEMINI_API_KEY',
    defaultTranslationModel: 'gemini-4-hydrogen',
    defaultVisionModel: 'gemini-4-hydrogen',
    models: [
      {
        id: 'gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'متاح في الخطة المجانية',
        pricingNoteEn: 'Available on free tier',
      },
      {
        id: 'gemini-3.1-flash-lite',
        label: 'Gemini 3.1 Flash Lite',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'سريع واقتصادي · متاح مجاناً',
        pricingNoteEn: 'Fast & lightweight · Free tier',
      },
      {
        id: 'gemini-4-argon',
        label: 'Gemini 4 Argon',
        supportsVision: true,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'يتطلب مفتاحاً مدفوعاً',
        pricingNoteEn: 'Paid API key required',
      },
    ],
  },
  {
    id: 'groq',
    name: 'Groq API',
    subtitleAr: 'استدلال فائق السرعة عبر LPU مع دعم Llama 4 للرؤية والنصوص',
    subtitleEn: 'Ultra-fast LPU inference with Llama 4 Vision & Text translation',
    apiKeyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/overview',
    defaultEndpointUrl: 'https://api.groq.com/openai/v1',
    supportsVision: true,
    supportsDynamicModels: true,
    requiresAccountId: false,
    freeTierAr: 'حصة مجانية يومية محدودة بعدد الطلبات والتوكنات في الدقيقة',
    freeTierEn: 'Free developer tier with per-minute & daily rate limits',
    secretEnvVar: 'GROQ_API_KEY',
    defaultTranslationModel: 'llama-3.3-70b-versatile',
    defaultVisionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    models: [
      {
        id: 'meta-llama/llama-4-scout-17b-16e-instruct',
        label: 'Llama 4 Scout 17B (Vision + Text)',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'يدعم الصور والنصوص · حصة مجانية',
        pricingNoteEn: 'Vision + Text · Free tier',
      },
      {
        id: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        label: 'Llama 4 Maverick 17B (Vision + Text)',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'يدعم الصور والنصوص · حصة مجانية',
        pricingNoteEn: 'Vision + Text · Free tier',
      },
      {
        id: 'llama-3.3-70b-versatile',
        label: 'Llama 3.3 70B Versatile',
        supportsVision: false,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'نصي فقط · حصة مجانية',
        pricingNoteEn: 'Text-only · Free tier',
      },
      {
        id: 'qwen-qwq-32b',
        label: 'Qwen QwQ 32B',
        supportsVision: false,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'نصي فقط · حصة مجانية',
        pricingNoteEn: 'Text-only · Free tier',
      },
      {
        id: 'llama-3.1-8b-instant',
        label: 'Llama 3.1 8B Instant',
        supportsVision: false,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'نصي سريع · حصة مجانية',
        pricingNoteEn: 'Fast text-only · Free tier',
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter API',
    subtitleAr: 'بوابة موحدة لمئات النماذج المجانية والمدفوعة للرؤية والترجمة',
    subtitleEn: 'Unified gateway for free & paid Vision and Translation models',
    apiKeyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    defaultEndpointUrl: 'https://openrouter.ai/api/v1',
    supportsVision: true,
    supportsDynamicModels: true,
    requiresAccountId: false,
    freeTierAr: 'النماذج المنتهية بـ :free مجانية (بحدود طلبات)، والنماذج الأخرى مدفوعة حسب الرصيد',
    freeTierEn: ':free models are free (rate-limited); other models bill per credit',
    secretEnvVar: 'OPENROUTER_API_KEY',
    defaultTranslationModel: 'deepseek/deepseek-chat-v3-0324:free',
    defaultVisionModel: 'qwen/qwen2.5-vl-72b-instruct:free',
    models: [
      {
        id: 'qwen/qwen2.5-vl-72b-instruct:free',
        label: 'Qwen 2.5 VL 72B (:free)',
        supportsVision: true,
        isFree: true,
        tier: 'free',
        pricingNoteAr: 'مجاني · يدعم الصور OCR',
        pricingNoteEn: 'Free · Vision OCR',
      },
      {
        id: 'meta-llama/llama-4-scout:free',
        label: 'Llama 4 Scout (:free)',
        supportsVision: true,
        isFree: true,
        tier: 'free',
        pricingNoteAr: 'مجاني · يدعم الصور OCR',
        pricingNoteEn: 'Free · Vision OCR',
      },
      {
        id: 'deepseek/deepseek-chat-v3-0324:free',
        label: 'DeepSeek V3 0324 (:free)',
        supportsVision: false,
        isFree: true,
        tier: 'free',
        pricingNoteAr: 'مجاني · نصي فقط',
        pricingNoteEn: 'Free · Text-only',
      },
      {
        id: 'qwen/qwen3-235b-a22b:free',
        label: 'Qwen 3 235B (:free)',
        supportsVision: false,
        isFree: true,
        tier: 'free',
        pricingNoteAr: 'مجاني · نصي فقط',
        pricingNoteEn: 'Free · Text-only',
      },
      {
        id: 'openai/gpt-4o-mini',
        label: 'GPT-4o Mini',
        supportsVision: true,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'مدفوع · يدعم الصور',
        pricingNoteEn: 'Paid · Vision + Text',
      },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    subtitleAr: 'تشغيل نماذج Llama و Qwen على شبكة Cloudflare السحابية',
    subtitleEn: 'Serverless Llama & Qwen inference on Cloudflare edge network',
    apiKeyUrl: 'https://dash.cloudflare.com/',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/',
    defaultEndpointUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1',
    supportsVision: true,
    supportsDynamicModels: true,
    requiresAccountId: true,
    freeTierAr: 'حصة مجانية يومية (10,000 Neurons/يوم في الخطة المجانية) يتطلب Account ID',
    freeTierEn: '10,000 free daily Neurons on free plan · Requires Account ID',
    secretEnvVar: 'CLOUDFLARE_API_TOKEN',
    defaultTranslationModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    defaultVisionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
    models: [
      {
        id: '@cf/meta/llama-3.2-11b-vision-instruct',
        label: 'Llama 3.2 11B Vision Instruct',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'يدعم الصور · ضمن حصة Neurons المجانية',
        pricingNoteEn: 'Vision + Text · Free daily Neurons',
      },
      {
        id: '@cf/meta/llama-4-scout-17b-16e-instruct',
        label: 'Llama 4 Scout 17B Instruct',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'يدعم الصور · حصة مجانية/مدفوعة',
        pricingNoteEn: 'Vision + Text · Free daily quota',
      },
      {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        label: 'Llama 3.3 70B Instruct Fast',
        supportsVision: false,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'نصي فقط · حصة يومية مجانية',
        pricingNoteEn: 'Text-only · Free daily Neurons',
      },
      {
        id: '@cf/qwen/qwq-32b',
        label: 'Qwen QwQ 32B',
        supportsVision: false,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'نصي فقط · حصة يومية مجانية',
        pricingNoteEn: 'Text-only · Free daily Neurons',
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek API',
    subtitleAr: 'ترجمة حوارات الكوميكس بذكاء لغوي عميق وأسلوب طبيعي (نصي فقط)',
    subtitleEn: 'Deep dialogue & reasoning comic translation (Text-only)',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    defaultEndpointUrl: 'https://api.deepseek.com/v1',
    supportsVision: false,
    supportsDynamicModels: true,
    requiresAccountId: false,
    freeTierAr: 'استخدام مدفوع حسب الاستهلاك (قد تتوفر أرصدة ترحيبية للحسابات الجديدة)',
    freeTierEn: 'Pay-as-you-go API (starter credits may apply to new accounts)',
    secretEnvVar: 'DEEPSEEK_API_KEY',
    defaultTranslationModel: 'deepseek-chat',
    models: [
      {
        id: 'deepseek-chat',
        label: 'DeepSeek V3 (deepseek-chat)',
        supportsVision: false,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'نصي فقط · مدفوع',
        pricingNoteEn: 'Text-only · Paid',
      },
      {
        id: 'deepseek-reasoner',
        label: 'DeepSeek R1 (deepseek-reasoner)',
        supportsVision: false,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'نصي للاستدلال · مدفوع',
        pricingNoteEn: 'Reasoning text-only · Paid',
      },
    ],
  },
  {
    id: 'qwen_studio',
    name: 'Qwen Studio (DashScope)',
    subtitleAr: 'نماذج Qwen للترجمة الاحترافية + Qwen-VL لاستخراج النصوص من الصفحات',
    subtitleEn: 'Qwen Max/Plus Translation + Qwen-VL Vision OCR',
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
    docsUrl:
      'https://www.alibabacloud.com/help/en/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
    defaultEndpointUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    supportsVision: true,
    supportsDynamicModels: true,
    requiresAccountId: false,
    freeTierAr: 'حصة تجربة مجانية محدودة للحسابات الجديدة ثم الدفع حسب الاستخدام',
    freeTierEn: 'Free trial quota for new accounts, then pay-as-you-go',
    secretEnvVar: 'QWEN_API_KEY',
    defaultTranslationModel: 'qwen-plus',
    defaultVisionModel: 'qwen-vl-max',
    models: [
      {
        id: 'qwen-plus',
        label: 'Qwen Plus',
        supportsVision: false,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'نصي متوازن · مدفوع/حصة تجريبية',
        pricingNoteEn: 'Balanced text · Paid / trial quota',
      },
      {
        id: 'qwen-max',
        label: 'Qwen Max',
        supportsVision: false,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'نصي فائق الجودة · مدفوع',
        pricingNoteEn: 'Flagship text · Paid',
      },
      {
        id: 'qwen-turbo',
        label: 'Qwen Turbo',
        supportsVision: false,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'نصي سريع · مدفوع/حصة تجريبية',
        pricingNoteEn: 'Fast text · Paid / trial quota',
      },
      {
        id: 'qwen-vl-max',
        label: 'Qwen VL Max (Vision OCR)',
        supportsVision: true,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'يدعم الصور OCR · مدفوع/تجريبي',
        pricingNoteEn: 'Vision OCR · Paid / trial quota',
      },
      {
        id: 'qwen-vl-plus',
        label: 'Qwen VL Plus (Vision OCR)',
        supportsVision: true,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'يدعم الصور OCR · مدفوع/تجريبي',
        pricingNoteEn: 'Fast Vision OCR · Paid / trial quota',
      },
    ],
  },
];

const QWEN_ENDPOINTS = [
  {
    labelAr: 'دولي — سنغافورة (DashScope Intl)',
    labelEn: 'International — Singapore (DashScope Intl)',
    url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  {
    labelAr: 'الصين — بكين (DashScope CN)',
    labelEn: 'China — Beijing (DashScope CN)',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
];

function buildDefaultProvidersMap(
  catalog: ProviderCatalogInfo[]
): Record<AiProviderId, ProviderEndpointConfig> {
  const map = {} as Record<AiProviderId, ProviderEndpointConfig>;
  for (const item of catalog) {
    map[item.id] = {
      translationModel: item.defaultTranslationModel,
      visionModel: item.defaultVisionModel,
      endpointUrl: item.defaultEndpointUrl,
      accountId: item.requiresAccountId ? '' : undefined,
    };
  }
  return map;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  lang,
  theme,
  settings,
  serverConfigured,
  providersStatus,
  providersDetailed,
  availableFonts,
  onChangeLang,
  onChangeTheme,
  onSettingsUpdated,
  onFontAdded,
}) => {
  const t = tFor(lang);
  const [catalog, setCatalog] = useState<ProviderCatalogInfo[]>(FALLBACK_CATALOG);
  const [draft, setDraft] = useState<AiSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [savedFlag, setSavedFlag] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Local transient API key inputs (never synced to localStorage or plain db)
  const [apiKeyInputs, setApiKeyInputs] = useState<Partial<Record<AiProviderId, string>>>({});
  const [showKeyMap, setShowKeyMap] = useState<Partial<Record<AiProviderId, boolean>>>({});
  const [keyBusyMap, setKeyBusyMap] = useState<Partial<Record<AiProviderId, boolean>>>({});
  const [keyFeedbackMap, setKeyFeedbackMap] = useState<
    Partial<Record<AiProviderId, { ok: boolean; msg: string }>>
  >({});

  // Dynamic models fetched from live APIs per provider
  const [dynamicModels, setDynamicModels] = useState<
    Partial<Record<AiProviderId, ProviderModelMeta[]>>
  >({});
  const [fetchingModelsFor, setFetchingModelsFor] = useState<AiProviderId | null>(null);
  const [modelsNoteMap, setModelsNoteMap] = useState<Partial<Record<AiProviderId, string>>>({});
  const [manualModelToggle, setManualModelToggle] = useState<Partial<Record<AiProviderId, boolean>>>(
    {}
  );

  // Per-provider test state
  const [testingProvider, setTestingProvider] = useState<AiProviderId | null>(null);
  const [testVisionMap, setTestVisionMap] = useState<Partial<Record<AiProviderId, boolean>>>({});
  const [providerTests, setProviderTests] = useState<
    Partial<Record<AiProviderId, ProviderTestResult | { ok: false; message: string }>>
  >({});

  const fontInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAiCatalog()
      .then((res) => {
        if (!cancelled && Array.isArray(res.catalog) && res.catalog.length > 0) {
          setCatalog(res.catalog);
        }
      })
      .catch(() => {
        // Fallback catalog already active
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultProvidersMap = buildDefaultProvidersMap(catalog);
  const providersConfig: Record<AiProviderId, ProviderEndpointConfig> = {
    ...defaultProvidersMap,
    ...(draft.providers || {}),
  };

  const activeTranslationProvider: AiProviderId = ALL_PROVIDER_IDS.includes(
    draft.provider as AiProviderId
  )
    ? (draft.provider as AiProviderId)
    : 'gemini';

  const activeVisionProvider: AiProviderId =
    draft.visionProvider &&
    catalog.find((c) => c.id === draft.visionProvider)?.supportsVision
      ? draft.visionProvider
      : 'gemini';

  const updateProviderField = (
    providerId: AiProviderId,
    patch: Partial<ProviderEndpointConfig>
  ) => {
    const current = providersConfig[providerId] || defaultProvidersMap[providerId];
    const nextCfg: ProviderEndpointConfig = { ...current, ...patch };

    // Auto-compute Cloudflare Base URL whenever Account ID changes
    if (providerId === 'cloudflare' && patch.accountId !== undefined) {
      const cleanId = patch.accountId.trim();
      if (cleanId) {
        nextCfg.endpointUrl = `https://api.cloudflare.com/client/v4/accounts/${cleanId}/ai/v1`;
      } else {
        nextCfg.endpointUrl =
          'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1';
      }
    }

    const updatedProviders = {
      ...providersConfig,
      [providerId]: nextCfg,
    };
    const nextDraft: AiSettings = {
      ...draft,
      providers: updatedProviders,
    };
    if (activeTranslationProvider === providerId && patch.translationModel !== undefined) {
      nextDraft.translationModel = patch.translationModel;
    }
    if (activeVisionProvider === providerId && patch.visionModel !== undefined) {
      nextDraft.visionOcrModel = patch.visionModel;
    }
    setDraft(nextDraft);
  };

  const selectTranslationProvider = (providerId: AiProviderId) => {
    const cfg = providersConfig[providerId] || defaultProvidersMap[providerId];
    setDraft({
      ...draft,
      provider: providerId,
      translationModel: cfg.translationModel,
      providers: providersConfig,
    });
  };

  const selectVisionProvider = (providerId: AiProviderId) => {
    const card = catalog.find((c) => c.id === providerId);
    if (!card?.supportsVision) return;
    const cfg = providersConfig[providerId] || defaultProvidersMap[providerId];
    setDraft({
      ...draft,
      visionProvider: providerId,
      visionOcrModel: cfg.visionModel || card.defaultVisionModel || cfg.translationModel,
      providers: providersConfig,
    });
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError('');
    try {
      const res = await api.updateSettings(draft);
      onSettingsUpdated(res.settings, res.providersStatus, res.providersDetailed);
      setSavedFlag(true);
      setTimeout(() => setSavedFlag(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProviderKey = async (providerId: AiProviderId) => {
    const rawKey = (apiKeyInputs[providerId] || '').trim();
    if (!rawKey) return;
    setKeyBusyMap((prev) => ({ ...prev, [providerId]: true }));
    setKeyFeedbackMap((prev) => ({ ...prev, [providerId]: undefined }));
    try {
      const cfg = providersConfig[providerId] || defaultProvidersMap[providerId];
      const res = await api.saveProviderKey(providerId, {
        apiKey: rawKey,
        accountId: cfg.accountId,
        endpointUrl: cfg.endpointUrl,
      });
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      setShowKeyMap((prev) => ({ ...prev, [providerId]: false }));
      onSettingsUpdated(res.settings, res.providersStatus, res.providersDetailed);
      setKeyFeedbackMap((prev) => ({
        ...prev,
        [providerId]: {
          ok: true,
          msg:
            lang === 'ar'
              ? 'تم حفظ وتشفير المفتاح على الخادم بأمان'
              : 'Key encrypted & saved securely on server',
        },
      }));
    } catch (err) {
      setKeyFeedbackMap((prev) => ({
        ...prev,
        [providerId]: {
          ok: false,
          msg: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setKeyBusyMap((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const handleDeleteProviderKey = async (providerId: AiProviderId) => {
    setKeyBusyMap((prev) => ({ ...prev, [providerId]: true }));
    setKeyFeedbackMap((prev) => ({ ...prev, [providerId]: undefined }));
    try {
      const res = await api.deleteProviderKey(providerId);
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      onSettingsUpdated(draft, res.providersStatus, res.providersDetailed);
      setProviderTests((prev) => ({ ...prev, [providerId]: undefined }));
      setKeyFeedbackMap((prev) => ({
        ...prev,
        [providerId]: {
          ok: true,
          msg: lang === 'ar' ? 'تم حذف المفتاح من الخزنة' : 'Removed stored key from server vault',
        },
      }));
    } catch (err) {
      setKeyFeedbackMap((prev) => ({
        ...prev,
        [providerId]: {
          ok: false,
          msg: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setKeyBusyMap((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const handleRefreshModels = async (providerId: AiProviderId) => {
    setFetchingModelsFor(providerId);
    setModelsNoteMap((prev) => ({ ...prev, [providerId]: undefined }));
    try {
      const cfg = providersConfig[providerId] || defaultProvidersMap[providerId];
      const typedKey = (apiKeyInputs[providerId] || '').trim();
      const res = await api.fetchProviderModels(providerId, {
        apiKey: typedKey || undefined,
        endpointUrl: cfg.endpointUrl,
        accountId: cfg.accountId,
      });
      setDynamicModels((prev) => ({ ...prev, [providerId]: res.models }));
      setModelsNoteMap((prev) => ({
        ...prev,
        [providerId]:
          res.source === 'live'
            ? lang === 'ar'
              ? `تم جلب ${res.models.length} نموذجاً مباشرة من المزود`
              : `Fetched ${res.models.length} live models from API`
            : res.warning ||
              (lang === 'ar'
                ? 'تم عرض القائمة الرسمية المعتمدة'
                : 'Showing official catalog models'),
      }));
    } catch (err) {
      setModelsNoteMap((prev) => ({
        ...prev,
        [providerId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setFetchingModelsFor(null);
    }
  };

  const handleTestProvider = async (card: ProviderCatalogInfo) => {
    const providerId = card.id;
    setTestingProvider(providerId);
    setProviderTests((prev) => ({ ...prev, [providerId]: undefined }));
    try {
      const cfg = providersConfig[providerId] || defaultProvidersMap[providerId];
      const typedKey = (apiKeyInputs[providerId] || '').trim();
      const res = await api.testAiConnection({
        provider: providerId,
        model: cfg.translationModel,
        visionModel: card.supportsVision ? cfg.visionModel || card.defaultVisionModel : undefined,
        endpointUrl: cfg.endpointUrl,
        accountId: cfg.accountId,
        apiKey: typedKey || undefined,
        testVision: Boolean(card.supportsVision && testVisionMap[providerId]),
      });
      setProviderTests((prev) => ({ ...prev, [providerId]: res }));
    } catch (err) {
      setProviderTests((prev) => ({
        ...prev,
        [providerId]: {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setTestingProvider(null);
    }
  };

  const handleUploadCustomFont = async (file: File | undefined) => {
    if (!file) return;
    const cleanName = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\u0600-\u06FF -]/g, '');
    const buf = await file.arrayBuffer();
    const face = new FontFace(cleanName, buf);
    await face.load();
    document.fonts.add(face);
    onFontAdded(cleanName);
  };

  const rawFallbackOrder = draft.fallbackOrder || ALL_PROVIDER_IDS;
  const fallbackOrder: AiProviderId[] = [
    ...rawFallbackOrder.filter((id): id is AiProviderId => ALL_PROVIDER_IDS.includes(id)),
    ...ALL_PROVIDER_IDS.filter((id) => !rawFallbackOrder.includes(id)),
  ];

  const moveFallbackItem = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= fallbackOrder.length) return;
    const next = [...fallbackOrder];
    const [picked] = next.splice(index, 1);
    next.splice(target, 0, picked);
    setDraft({ ...draft, fallbackOrder: next });
  };

  return (
    <div className="max-w-6xl w-full mx-auto px-4 lg:px-8 py-6 space-y-8">
      <div className="pb-5 border-b-2 border-[#111111]/15 dark:border-white/15">
        <h1 className="font-display-comic text-2xl sm:text-3xl font-black text-[#111111] dark:text-[#FFFDF9]">{t.settings.title}</h1>
        <p className="text-sm font-semibold text-[#595650] dark:text-[#A9A69E] mt-1">{t.settings.subtitle}</p>
      </div>

      {/* Interface Preferences */}
      <section className="p-5 faqqa-card space-y-4">
        <h2 className="font-display-comic text-base font-black text-[#111111] dark:text-[#FFFDF9]">{t.settings.uiPrefs}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              {t.settings.language}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChangeLang('ar')}
                className={`flex-1 py-2 rounded-xl border-2 text-xs font-extrabold cursor-pointer transition-all ${
                  lang === 'ar'
                    ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'border-[#111111]/20 dark:border-white/15 hover:border-[#111111] dark:hover:border-white/40'
                }`}
              >
                العربية (RTL)
              </button>
              <button
                type="button"
                onClick={() => onChangeLang('en')}
                className={`flex-1 py-2 rounded-xl border-2 text-xs font-extrabold cursor-pointer transition-all ${
                  lang === 'en'
                    ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'border-[#111111]/20 dark:border-white/15 hover:border-[#111111] dark:hover:border-white/40'
                }`}
              >
                English (LTR)
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              {t.settings.theme}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChangeTheme('light')}
                className={`flex-1 py-2 rounded-xl border-2 text-xs font-extrabold cursor-pointer transition-all ${
                  theme === 'light'
                    ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'border-[#111111]/20 dark:border-white/15 hover:border-[#111111] dark:hover:border-white/40'
                }`}
              >
                {t.settings.light}
              </button>
              <button
                type="button"
                onClick={() => onChangeTheme('dark')}
                className={`flex-1 py-2 rounded-xl border-2 text-xs font-extrabold cursor-pointer transition-all ${
                  theme === 'dark'
                    ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'border-[#111111]/20 dark:border-white/15 hover:border-[#111111] dark:hover:border-white/40'
                }`}
              >
                {t.settings.dark}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Multi-API Hub + AI Processing Settings Form */}
      <form onSubmit={handleSaveSettings} className="space-y-6">
        <section
          aria-label={t.settings.multiApiTitle}
          className="p-5 faqqa-card space-y-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#EA3829] dark:text-[#FFE01B]" />
                <h2 className="font-display-comic text-base font-black text-[#111111] dark:text-[#FFFDF9]">
                  {t.settings.multiApiTitle}
                </h2>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t.settings.multiApiSubtitle}
              </p>
            </div>

            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>
                {serverConfigured
                  ? lang === 'ar'
                    ? 'يوجد مزود جاهز على الخادم'
                    : 'Server AI Ready'
                  : lang === 'ar'
                  ? 'أضف مفتاح مزود واحد على الأقل'
                  : 'Add at least one provider API key'}
              </span>
            </div>
          </div>

          {/* 6 Independent Provider Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {catalog.map((card) => {
              const cfg = providersConfig[card.id] || defaultProvidersMap[card.id];
              const isTransActive = activeTranslationProvider === card.id;
              const isVisionActive = activeVisionProvider === card.id;
              const detail = providersDetailed?.[card.id];
              const isSecretSet = Boolean(detail?.configured ?? providersStatus[card.id]);
              const testState = providerTests[card.id];
              const keyFeedback = keyFeedbackMap[card.id];
              const keyInputVal = apiKeyInputs[card.id] || '';
              const showKey = Boolean(showKeyMap[card.id]);
              const keyBusy = Boolean(keyBusyMap[card.id]);

              const modelsList = dynamicModels[card.id] || card.models;
              const visionModels = modelsList.filter((m) => m.supportsVision);
              const selectedTransMeta = modelsList.find((m) => m.id === cfg.translationModel);
              const selectedVisionMeta = visionModels.find(
                (m) => m.id === (cfg.visionModel || card.defaultVisionModel)
              );
              const isManualModelOpen =
                Boolean(manualModelToggle[card.id]) ||
                (Boolean(cfg.translationModel) &&
                  !modelsList.some((m) => m.id === cfg.translationModel));

              const statusKind: 'connected' | 'saved' | 'error' | 'missing' =
                testState?.ok
                  ? 'connected'
                  : testState && !testState.ok
                  ? 'error'
                  : isSecretSet
                  ? 'saved'
                  : 'missing';

              return (
                <article
                  key={card.id}
                  data-testid={`provider-card-${card.id}`}
                  className={`rounded-2xl border-[2.5px] p-4 sm:p-5 flex flex-col justify-between gap-4 transition-all ${
                    isTransActive
                      ? 'border-[#111111] dark:border-[#FFE01B] bg-[#FFE01B]/12 dark:bg-[#FFE01B]/8 shadow-[4px_4px_0px_#111111] dark:shadow-[4px_4px_0px_#FFE01B]'
                      : 'border-[#111111]/25 dark:border-white/15 bg-[#FAF5E8]/60 dark:bg-[#111216]'
                  }`}
                >
                  <div className="space-y-4">
                    {/* 1. Card Header: Logo + Name + Connection Status */}
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22] flex items-center justify-center shrink-0 mt-0.5">
                          <ProviderLogo provider={card.id} className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-slate-900 dark:text-white leading-snug">
                            {card.name}
                          </h3>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug mt-0.5">
                            {lang === 'ar' ? card.subtitleAr : card.subtitleEn}
                          </p>
                        </div>
                      </div>

                      {/* Connection Status Indicator (Icon + Semantic Label) */}
                      <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-1.5 sm:gap-1 shrink-0">
                        <span
                          data-testid={`provider-status-${card.id}`}
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md border whitespace-nowrap ${
                            statusKind === 'connected'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                              : statusKind === 'error'
                              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300'
                              : statusKind === 'saved'
                              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
                              : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
                          }`}
                        >
                          {statusKind === 'error' ? (
                            <AlertCircle className="w-3 h-3" />
                          ) : statusKind === 'missing' ? (
                            <KeyRound className="w-3 h-3" />
                          ) : (
                            <CheckCircle2 className="w-3 h-3" />
                          )}
                          <span>
                            {statusKind === 'connected'
                              ? t.settings.statusConnected
                              : statusKind === 'error'
                              ? t.settings.statusError
                              : statusKind === 'saved'
                              ? t.settings.statusSaved
                              : t.settings.statusMissing}
                          </span>
                        </span>

                        {detail?.configured && detail.maskedHint && (
                          <span
                            dir="ltr"
                            className="text-[10px] font-mono text-slate-500 dark:text-slate-400"
                          >
                            {detail.source === 'vault'
                              ? t.settings.vaultSource
                              : t.settings.envSource}{' '}
                            · {detail.maskedHint}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 2. API Key Input + Show/Hide + Save/Delete + ALWAYS VISIBLE Get Key Link */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          htmlFor={`apikey-input-${card.id}`}
                          className="text-[11px] font-semibold text-slate-700 dark:text-slate-200"
                        >
                          {t.settings.apiKeyLabel}{' '}
                          <span dir="ltr" className="font-mono text-[10px] text-slate-400">
                            ({card.secretEnvVar})
                          </span>
                        </label>
                        <a
                          href={card.apiKeyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`get-key-link-${card.id}`}
                          className="inline-flex items-center gap-1 text-[11px] font-extrabold text-[#EA3829] dark:text-[#FFE01B] hover:underline whitespace-nowrap shrink-0"
                        >
                          {t.settings.getApiKey}
                        </a>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <div className="flex flex-1 min-w-0 items-center rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-white dark:bg-[#1A1B21] focus-within:border-[#111111] dark:focus-within:border-[#FFE01B]">
                          <input
                            id={`apikey-input-${card.id}`}
                            data-testid={`apikey-input-${card.id}`}
                            type={showKey ? 'text' : 'password'}
                            dir={keyInputVal ? 'ltr' : lang === 'ar' ? 'rtl' : 'ltr'}
                            autoComplete="off"
                            spellCheck={false}
                            value={keyInputVal}
                            onChange={(e) =>
                              setApiKeyInputs((prev) => ({ ...prev, [card.id]: e.target.value }))
                            }
                            placeholder={
                              isSecretSet
                                ? t.settings.apiKeySavedPlaceholder
                                : t.settings.apiKeyPlaceholder
                            }
                            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowKeyMap((prev) => ({ ...prev, [card.id]: !showKey }))
                            }
                            aria-label={showKey ? t.settings.hideKey : t.settings.showKey}
                            title={showKey ? t.settings.hideKey : t.settings.showKey}
                            data-testid={`toggle-key-visibility-${card.id}`}
                            className="px-2 py-1.5 flex items-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer shrink-0"
                          >
                            {showKey ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        <button
                          type="button"
                          disabled={keyBusy || !keyInputVal.trim()}
                          onClick={() => void handleSaveProviderKey(card.id)}
                          data-testid={`save-key-btn-${card.id}`}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-[11px] font-semibold hover:opacity-90 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {isSecretSet ? t.settings.replaceKey : t.settings.saveKey}
                        </button>

                        {detail?.source === 'vault' && (
                          <button
                            type="button"
                            disabled={keyBusy}
                            onClick={() => void handleDeleteProviderKey(card.id)}
                            aria-label={t.settings.deleteKey}
                            title={t.settings.deleteKey}
                            data-testid={`delete-key-btn-${card.id}`}
                            className="p-1.5 rounded-lg border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {keyFeedback && (
                        <p
                          className={`text-[11px] ${
                            keyFeedback.ok
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {keyFeedback.msg}
                        </p>
                      )}
                    </div>

                    {/* 3. Connection Settings (Account ID for Cloudflare, Region for Qwen, Base URL + Official Docs Link) */}
                    <div className="space-y-2">
                      {card.requiresAccountId && (
                        <div>
                          <label
                            htmlFor={`account-id-${card.id}`}
                            className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1"
                          >
                            {t.settings.accountIdLabel}
                          </label>
                          <input
                            id={`account-id-${card.id}`}
                            data-testid={`account-id-input-${card.id}`}
                            type="text"
                            dir="ltr"
                            value={cfg.accountId || ''}
                            onChange={(e) =>
                              updateProviderField(card.id, { accountId: e.target.value })
                            }
                            placeholder={t.settings.accountIdPlaceholder}
                            className="w-full px-2.5 py-1.5 text-[11px] font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                          />
                        </div>
                      )}

                      {card.id === 'qwen_studio' && (
                        <div>
                          <select
                            aria-label="Qwen DashScope Region"
                            value={
                              QWEN_ENDPOINTS.some((q) => q.url === cfg.endpointUrl)
                                ? cfg.endpointUrl
                                : 'custom'
                            }
                            onChange={(e) => {
                              if (e.target.value !== 'custom') {
                                updateProviderField('qwen_studio', { endpointUrl: e.target.value });
                              }
                            }}
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                          >
                            {QWEN_ENDPOINTS.map((q) => (
                              <option key={q.url} value={q.url}>
                                {lang === 'ar' ? q.labelAr : q.labelEn}
                              </option>
                            ))}
                            <option value="custom">
                              {lang === 'ar' ? 'رابط مخصص (Custom URL)' : 'Custom URL'}
                            </option>
                          </select>
                        </div>
                      )}

                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                          <label
                            htmlFor={`endpoint-input-${card.id}`}
                            className="text-[11px] font-medium text-slate-500 dark:text-slate-400"
                          >
                            {t.settings.baseUrlLabel}
                          </label>
                          <div className="flex items-center gap-2.5">
                            {cfg.endpointUrl !== card.defaultEndpointUrl && !card.requiresAccountId && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateProviderField(card.id, {
                                    endpointUrl: card.defaultEndpointUrl,
                                  })
                                }
                                className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                                <span>{t.settings.resetUrl}</span>
                              </button>
                            )}
                            <a
                              href={card.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid={`docs-link-${card.id}`}
                              className="inline-flex items-center gap-1 text-[11px] font-bold text-[#595650] dark:text-[#A9A69E] hover:text-[#EA3829] dark:hover:text-[#FFE01B] hover:underline whitespace-nowrap shrink-0"
                            >
                              {t.settings.officialDocs}
                            </a>
                          </div>
                        </div>
                        <input
                          id={`endpoint-input-${card.id}`}
                          type="url"
                          dir="ltr"
                          value={cfg.endpointUrl}
                          onChange={(e) =>
                            updateProviderField(card.id, { endpointUrl: e.target.value })
                          }
                          className="w-full px-2.5 py-1.5 text-[11px] font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                        />
                      </div>
                    </div>

                    {/* 4. Models Selection (Dynamic Fetch + Vision vs Text + Free vs Paid + Manual ID) */}
                    <div className="space-y-2.5 pt-2 border-t border-slate-200/70 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-2">
                        <label
                          htmlFor={`trans-model-${card.id}`}
                          className="text-[11px] font-semibold text-slate-700 dark:text-slate-200"
                        >
                          {t.settings.translationModel}
                        </label>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setManualModelToggle((prev) => ({
                                ...prev,
                                [card.id]: !isManualModelOpen,
                              }))
                            }
                            className="text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
                          >
                            {lang === 'ar' ? 'إدخال يدوي' : 'Manual ID'}
                          </button>
                          {card.supportsDynamicModels && (
                            <button
                              type="button"
                              disabled={fetchingModelsFor === card.id}
                              onClick={() => void handleRefreshModels(card.id)}
                              data-testid={`refresh-models-${card.id}`}
                              className="inline-flex items-center gap-1 text-[11px] font-bold text-[#EA3829] dark:text-[#FFE01B] hover:underline cursor-pointer disabled:opacity-50 whitespace-nowrap"
                            >
                              {fetchingModelsFor === card.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3 h-3" />
                              )}
                              <span>{t.settings.refreshModels}</span>
                            </button>
                          )}
                        </div>
                      </div>

                      <select
                        id={`trans-model-${card.id}`}
                        dir="ltr"
                        value={
                          modelsList.some((m) => m.id === cfg.translationModel)
                            ? cfg.translationModel
                            : '__custom__'
                        }
                        onChange={(e) => {
                          if (e.target.value !== '__custom__') {
                            updateProviderField(card.id, { translationModel: e.target.value });
                          } else {
                            setManualModelToggle((prev) => ({ ...prev, [card.id]: true }));
                          }
                        }}
                        className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                      >
                        {modelsList.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} [{m.supportsVision ? t.settings.visionCapableTag : t.settings.textOnlyTag}] [
                            {m.isFree ? t.settings.freeTag : t.settings.paidTag}]
                          </option>
                        ))}
                        {!modelsList.some((m) => m.id === cfg.translationModel) && (
                          <option value="__custom__">
                            {cfg.translationModel} (Custom)
                          </option>
                        )}
                      </select>

                      {selectedTransMeta && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-1.5">
                          <span
                            className={
                              selectedTransMeta.isFree
                                ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                                : 'text-amber-700 dark:text-amber-400 font-medium'
                            }
                          >
                            {selectedTransMeta.isFree ? t.settings.freeTag : t.settings.paidTag}
                          </span>
                          <span>·</span>
                          <span>
                            {selectedTransMeta.supportsVision
                              ? t.settings.visionCapableTag
                              : t.settings.textOnlyTag}
                          </span>
                        </div>
                      )}

                      {isManualModelOpen && (
                        <input
                          type="text"
                          dir="ltr"
                          aria-label={t.settings.customModelLabel}
                          value={cfg.translationModel}
                          onChange={(e) =>
                            updateProviderField(card.id, { translationModel: e.target.value })
                          }
                          placeholder={t.settings.customModelPlaceholder}
                          className="w-full px-2.5 py-1.5 text-[11px] font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                        />
                      )}

                      {modelsNoteMap[card.id] && (
                        <p className="text-[11px] font-semibold text-[#111111] dark:text-[#FFE01B]">
                          {modelsNoteMap[card.id]}
                        </p>
                      )}

                      {/* Vision OCR Model Selector (Strict Vision Filter) */}
                      {card.supportsVision && visionModels.length > 0 ? (
                        <div className="space-y-1">
                          <label
                            htmlFor={`vision-model-${card.id}`}
                            className="block text-[11px] font-semibold text-slate-700 dark:text-slate-200"
                          >
                            {t.settings.visionOcrModelLabel}
                          </label>
                          <select
                            id={`vision-model-${card.id}`}
                            dir="ltr"
                            value={
                              visionModels.some(
                                (m) => m.id === (cfg.visionModel || card.defaultVisionModel)
                              )
                                ? cfg.visionModel || card.defaultVisionModel
                                : visionModels[0].id
                            }
                            onChange={(e) =>
                              updateProviderField(card.id, { visionModel: e.target.value })
                            }
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                          >
                            {visionModels.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.label} [{m.isFree ? t.settings.freeTag : t.settings.paidTag}]
                              </option>
                            ))}
                          </select>
                          {selectedVisionMeta && (
                            <p className="text-[11px] text-slate-500 dark:text-slate-400">
                              {selectedVisionMeta.isFree ? t.settings.freeTag : t.settings.paidTag} ·{' '}
                              {t.settings.visionCapableTag}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                          {t.settings.visionUnsupportedDeepseek}
                        </p>
                      )}

                      {/* Concise Free Tier Summary */}
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {lang === 'ar' ? card.freeTierAr : card.freeTierEn}
                      </p>
                    </div>
                  </div>

                  {/* 5. Footer: Active Roles + Connection Test (Text + Optional Real PNG Vision Test) */}
                  <div className="pt-3 border-t border-slate-200/80 dark:border-slate-800 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => selectTranslationProvider(card.id)}
                        aria-pressed={isTransActive}
                        className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-extrabold border-2 whitespace-nowrap cursor-pointer transition-all ${
                          isTransActive
                            ? 'bg-[#FFE01B] border-[#111111] text-[#111111] shadow-[2px_2px_0px_#111111]'
                            : 'bg-white dark:bg-[#1A1B21] border-[#111111]/20 dark:border-white/20 text-[#111111] dark:text-[#FFFDF9] hover:border-[#111111]'
                        }`}
                      >
                        <Languages className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          {isTransActive ? t.settings.activeTranslationRole : t.settings.useForTranslation}
                        </span>
                      </button>

                      {card.supportsVision && (
                        <button
                          type="button"
                          onClick={() => selectVisionProvider(card.id)}
                          aria-pressed={isVisionActive}
                          className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap cursor-pointer ${
                            isVisionActive
                              ? 'bg-slate-900 border-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                              : 'bg-white dark:bg-[#161B22] border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <Eye className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            {isVisionActive ? t.settings.activeVisionRole : t.settings.useForVision}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={testingProvider === card.id}
                        onClick={() => void handleTestProvider(card)}
                        data-testid={`test-provider-${card.id}`}
                        className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#161B22] hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        {testingProvider === card.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <PlugZap className="w-3.5 h-3.5" />
                        )}
                        <span>{t.settings.testProvider}</span>
                      </button>
                    </div>

                    {card.supportsVision && (
                      <label className="inline-flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(testVisionMap[card.id])}
                          onChange={(e) =>
                            setTestVisionMap((prev) => ({ ...prev, [card.id]: e.target.checked }))
                          }
                          className="rounded border-slate-300"
                        />
                        <span>{t.settings.testVisionCheck}</span>
                      </label>
                    )}

                    {testState && (
                      <div
                        data-testid={`test-result-${card.id}`}
                        className={`p-2.5 rounded-lg text-[11px] border break-words space-y-1 ${
                          testState.ok
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
                        }`}
                      >
                        {'latencyMs' in testState ? (
                          <>
                            <div className="font-semibold">
                              {testState.model} · {testState.latencyMs}ms · {testState.message}
                            </div>
                            {testState.visionMessage && (
                              <div className="text-[10px] opacity-90">
                                OCR ({testState.visionModel}): {testState.visionMessage}
                              </div>
                            )}
                          </>
                        ) : (
                          <div>{testState.message}</div>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          {/* Automatic Fallback, Paid Consent & Priority Reordering */}
          <div className="p-4 rounded-2xl border-2 border-[#111111]/20 dark:border-white/15 bg-[#FAF5E8]/70 dark:bg-[#111216] space-y-4">
            <div className="space-y-2.5">
              <label className="flex items-start gap-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.autoFallback !== false}
                  onChange={(e) => setDraft({ ...draft, autoFallback: e.target.checked })}
                  className="mt-0.5 rounded border-slate-300"
                />
                <RefreshCw className="w-3.5 h-3.5 mt-0.5 text-[#EA3829] dark:text-[#FFE01B] shrink-0" />
                <span>{t.settings.autoFallbackLabel}</span>
              </label>

              <div className="ps-6 space-y-1">
                <label className="flex items-start gap-2.5 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="allow-paid-fallback-checkbox"
                    checked={Boolean(draft.allowPaidFallback)}
                    onChange={(e) =>
                      setDraft({ ...draft, allowPaidFallback: e.target.checked })
                    }
                    className="mt-0.5 rounded border-slate-300"
                  />
                  <span>{t.settings.allowPaidFallbackLabel}</span>
                </label>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t.settings.allowPaidFallbackWarning}
                </p>
              </div>
            </div>

            {/* Interactive Fallback Priority Order */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {t.settings.fallbackOrderLabel}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {fallbackOrder.map((pid, idx) => {
                  const meta = catalog.find((c) => c.id === pid);
                  const isReady = Boolean(providersStatus[pid]);
                  return (
                    <div
                      key={pid}
                      data-testid={`fallback-order-item-${pid}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[11px] font-mono-tabular font-bold text-slate-400 w-4">
                          {idx + 1}.
                        </span>
                        <ProviderLogo provider={pid} className="w-4 h-4 shrink-0" />
                        <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                          {meta?.name || pid}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isReady ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                          }`}
                          title={isReady ? t.settings.secretReady : t.settings.secretMissing}
                        />
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveFallbackItem(idx, -1)}
                          aria-label={`${t.settings.movePriorityUp} ${meta?.name || pid}`}
                          data-testid={`priority-up-${pid}`}
                          className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === fallbackOrder.length - 1}
                          onClick={() => moveFallbackItem(idx, 1)}
                          aria-label={`${t.settings.movePriorityDown} ${meta?.name || pid}`}
                          data-testid={`priority-down-${pid}`}
                          className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Processing, Inpainting & Concurrency Settings */}
        <section className="p-5 faqqa-card space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">
                {t.settings.inpaintingEngine}
              </label>
              <select
                value={draft.inpaintingEngine}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    inpaintingEngine: e.target.value as AiSettings['inpaintingEngine'],
                  })
                }
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
              >
                <option value="telea_biharmonic">{t.settings.inpaintTelea}</option>
                <option value="solid_interior">{t.settings.inpaintSolid}</option>
                <option value="manual_only">{t.settings.inpaintManual}</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">
                  {t.settings.parallelPages}
                </label>
                <input
                  type="number"
                  min="1"
                  max="4"
                  value={draft.parallelPages}
                  onChange={(e) => setDraft({ ...draft, parallelPages: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">
                  {t.settings.rateLimit}
                </label>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={draft.rateLimitPerMinute}
                  onChange={(e) =>
                    setDraft({ ...draft, rateLimitPerMinute: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-500">{t.settings.creativity}</span>
                <span className="font-mono-tabular">{Math.round(draft.creativity * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.creativity}
                onChange={(e) => setDraft({ ...draft, creativity: Number(e.target.value) })}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-500">{t.settings.fidelity}</span>
                <span className="font-mono-tabular">{Math.round(draft.fidelity * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.fidelity}
                onChange={(e) => setDraft({ ...draft, fidelity: Number(e.target.value) })}
                className="w-full"
              />
            </div>
          </div>

          {saveError && (
            <div className="p-3 rounded-lg text-xs border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              {saveError}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              data-testid="save-settings-btn"
              className="faqqa-btn-yellow inline-flex items-center gap-2 px-5 py-2 text-sm cursor-pointer disabled:opacity-50"
            >
              {savedFlag ? <Check className="w-4 h-4" /> : null}
              <span>{savedFlag ? t.settings.saved : t.settings.saveSettings}</span>
            </button>
          </div>
        </section>
      </form>

      {/* Custom Comic Fonts Import */}
      <section className="p-5 faqqa-card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              {t.settings.customFonts}
            </h2>
            <p className="text-xs text-slate-500">{availableFonts.join(' · ')}</p>
          </div>
          <button
            type="button"
            onClick={() => fontInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t.settings.uploadFont}</span>
          </button>
          <input
            ref={fontInputRef}
            type="file"
            accept=".ttf,.otf,.woff,.woff2"
            onChange={(e) => void handleUploadCustomFont(e.target.files?.[0])}
            className="hidden"
          />
        </div>
      </section>
    </div>
  );
};
