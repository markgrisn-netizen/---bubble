import type {
  AiProviderId,
  ProviderCatalogInfo,
  ProviderModelMeta,
} from '../src/types/domain.ts';

export const ALL_PROVIDER_IDS: AiProviderId[] = [
  'gemini',
  'groq',
  'openrouter',
  'cloudflare',
  'deepseek',
  'qwen_studio',
];

export const DEFAULT_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com';
export const DEFAULT_GROQ_ENDPOINT = 'https://api.groq.com/openai/v1';
export const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';
export const DEFAULT_CLOUDFLARE_ENDPOINT_TEMPLATE =
  'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1';
export const DEFAULT_DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1';
export const DEFAULT_QWEN_INTL_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_QWEN_CN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const PROVIDER_CATALOG: Record<AiProviderId, ProviderCatalogInfo> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini API',
    subtitleAr: 'الرؤية متعددة الوسائط OCR وترجمة السياق الكامل للفقاعات',
    subtitleEn: 'Multimodal Vision OCR & Context-Aware Comic Translation',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    defaultEndpointUrl: DEFAULT_GEMINI_ENDPOINT,
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
  groq: {
    id: 'groq',
    name: 'Groq API',
    subtitleAr: 'استدلال فائق السرعة عبر LPU مع دعم Llama 4 للرؤية والنصوص',
    subtitleEn: 'Ultra-fast LPU inference with Llama 4 Vision & Text translation',
    apiKeyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/overview',
    defaultEndpointUrl: DEFAULT_GROQ_ENDPOINT,
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
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter API',
    subtitleAr: 'بوابة موحدة لمئات النماذج المجانية والمدفوعة للرؤية والترجمة',
    subtitleEn: 'Unified gateway for free & paid Vision and Translation models',
    apiKeyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    defaultEndpointUrl: DEFAULT_OPENROUTER_ENDPOINT,
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
      {
        id: 'anthropic/claude-sonnet-4',
        label: 'Claude Sonnet 4',
        supportsVision: true,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'مدفوع · يدعم الصور',
        pricingNoteEn: 'Paid · Vision + Text',
      },
    ],
  },
  cloudflare: {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    subtitleAr: 'تشغيل نماذج Llama و Qwen على شبكة Cloudflare السحابية',
    subtitleEn: 'Serverless Llama & Qwen inference on Cloudflare edge network',
    apiKeyUrl: 'https://dash.cloudflare.com/',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/',
    defaultEndpointUrl: DEFAULT_CLOUDFLARE_ENDPOINT_TEMPLATE,
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
        id: '@cf/llava-hf/llava-1.5-7b-hf',
        label: 'LLaVA 1.5 7B Vision',
        supportsVision: true,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'يدعم الصور · ضمن الحصة المجانية',
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
      {
        id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
        label: 'DeepSeek R1 Distill Qwen 32B',
        supportsVision: false,
        isFree: true,
        tier: 'freemium',
        pricingNoteAr: 'نصي فقط · حصة يومية مجانية',
        pricingNoteEn: 'Text-only · Free daily Neurons',
      },
    ],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek API',
    subtitleAr: 'ترجمة حوارات الكوميكس بذكاء لغوي عميق وأسلوب طبيعي (نصي فقط)',
    subtitleEn: 'Deep dialogue & reasoning comic translation (Text-only)',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    defaultEndpointUrl: DEFAULT_DEEPSEEK_ENDPOINT,
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
  qwen_studio: {
    id: 'qwen_studio',
    name: 'Qwen Studio (DashScope)',
    subtitleAr: 'نماذج Qwen للترجمة الاحترافية + Qwen-VL لاستخراج النصوص من الصفحات',
    subtitleEn: 'Qwen Max/Plus Translation + Qwen-VL Vision OCR',
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
    docsUrl:
      'https://www.alibabacloud.com/help/en/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
    defaultEndpointUrl: DEFAULT_QWEN_INTL_ENDPOINT,
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
        id: 'qwen3-235b-a22b',
        label: 'Qwen 3 235B',
        supportsVision: false,
        isFree: false,
        tier: 'paid',
        pricingNoteAr: 'نصي متقدم · مدفوع',
        pricingNoteEn: 'Advanced text · Paid',
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
};

export function getProviderCatalogList(): ProviderCatalogInfo[] {
  return ALL_PROVIDER_IDS.map((id) => PROVIDER_CATALOG[id]);
}

export function extractCloudflareAccountId(endpointUrl?: string): string {
  if (!endpointUrl) return '';
  const match = endpointUrl.match(/\/accounts\/([^/]+)\/ai/i);
  if (!match) return '';
  const val = match[1];
  return val === '{ACCOUNT_ID}' ? '' : val;
}

export function resolveCloudflareEndpoint(accountId?: string, endpointUrl?: string): string {
  const cleanId = (accountId || extractCloudflareAccountId(endpointUrl)).trim();
  const cleanUrl = (endpointUrl || '').trim();
  if (cleanUrl && !cleanUrl.includes('{ACCOUNT_ID}')) {
    if (cleanId && /\/accounts\/[^/]+\/ai/i.test(cleanUrl)) {
      return cleanUrl.replace(/\/accounts\/[^/]+\/ai/i, `/accounts/${cleanId}/ai`);
    }
    return cleanUrl;
  }
  if (cleanId) {
    return `https://api.cloudflare.com/client/v4/accounts/${cleanId}/ai/v1`;
  }
  return DEFAULT_CLOUDFLARE_ENDPOINT_TEMPLATE;
}

export function isModelPaid(
  providerId: AiProviderId,
  modelId: string,
  dynamicModels?: ProviderModelMeta[]
): boolean {
  const combined = [...(dynamicModels || []), ...PROVIDER_CATALOG[providerId].models];
  const found = combined.find((m) => m.id === modelId);
  if (found) return !found.isFree;

  const lower = modelId.toLowerCase();
  if (providerId === 'openrouter') {
    return !lower.endsWith(':free') && !lower.includes(':free');
  }
  if (providerId === 'groq' || providerId === 'cloudflare') {
    return false;
  }
  if (providerId === 'gemini') {
    return (
      lower.includes('argon') ||
      lower.includes('carbon') ||
      lower.includes('pro-image') ||
      lower.includes('nano-banana')
    );
  }
  // DeepSeek and Qwen Studio are paid APIs by default once free trial credits expire
  return true;
}

export function isModelVisionCapable(
  providerId: AiProviderId,
  modelId: string,
  dynamicModels?: ProviderModelMeta[]
): boolean {
  if (!PROVIDER_CATALOG[providerId].supportsVision) return false;
  const combined = [...(dynamicModels || []), ...PROVIDER_CATALOG[providerId].models];
  const found = combined.find((m) => m.id === modelId);
  if (found) return found.supportsVision;

  const lower = modelId.toLowerCase();
  if (providerId === 'gemini') {
    return !lower.includes('embedding') && !lower.includes('tts') && !lower.includes('lyria');
  }
  return (
    lower.includes('vision') ||
    lower.includes('-vl') ||
    lower.includes('vl-') ||
    lower.includes('llava') ||
    lower.includes('llama-4-scout') ||
    lower.includes('llama-4-maverick') ||
    lower.includes('4o') ||
    lower.includes('claude') ||
    lower.includes('gemini') ||
    lower.includes('pixtral')
  );
}

const DEPRECATED_GEMINI_PATTERN =
  /gemini-1\.0|gemini-1\.5|gemini-2\.0|^gemini-pro$|^models\/gemini-pro$/i;

export function parseDynamicModelsResponse(
  providerId: AiProviderId,
  rawJson: unknown
): ProviderModelMeta[] {
  const curated = PROVIDER_CATALOG[providerId].models;
  const curatedMap = new Map(curated.map((m) => [m.id, m]));
  const result: ProviderModelMeta[] = [];
  const seen = new Set<string>();

  const pushUnique = (meta: ProviderModelMeta) => {
    if (!meta.id || seen.has(meta.id)) return;
    seen.add(meta.id);
    result.push(meta);
  };

  if (providerId === 'gemini') {
    const models = Array.isArray((rawJson as { models?: unknown[] })?.models)
      ? ((rawJson as { models: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> }).models)
      : [];
    for (const item of models) {
      const id = String(item.name || '').replace(/^models\//, '');
      if (!id || DEPRECATED_GEMINI_PATTERN.test(id)) continue;
      const methods = item.supportedGenerationMethods || [];
      if (methods.length > 0 && !methods.includes('generateContent')) continue;
      const known = curatedMap.get(id);
      if (known) {
        pushUnique(known);
      } else {
        const lower = id.toLowerCase();
        const isPaid =
          lower.includes('argon') || lower.includes('carbon') || lower.includes('pro');
        pushUnique({
          id,
          label: item.displayName || id,
          supportsVision: !lower.includes('embedding') && !lower.includes('tts'),
          isFree: !isPaid,
          tier: isPaid ? 'paid' : 'freemium',
          pricingNoteAr: isPaid ? 'مدفوع / حسب الخطة' : 'متاح في الخطة المجانية',
          pricingNoteEn: isPaid ? 'Paid tier' : 'Free tier available',
        });
      }
    }
  } else if (providerId === 'cloudflare') {
    const items = Array.isArray((rawJson as { result?: unknown[] })?.result)
      ? ((rawJson as {
          result: Array<{
            name?: string;
            description?: string;
            task?: { name?: string };
          }>;
        }).result)
      : [];
    for (const item of items) {
      const id = String(item.name || '').trim();
      if (!id) continue;
      const taskName = String(item.task?.name || '').toLowerCase();
      if (
        taskName &&
        !taskName.includes('text generation') &&
        !taskName.includes('image-to-text') &&
        !taskName.includes('multimodal')
      ) {
        continue;
      }
      const known = curatedMap.get(id);
      if (known) {
        pushUnique(known);
      } else {
        const supportsVision =
          taskName.includes('image-to-text') ||
          taskName.includes('multimodal') ||
          isModelVisionCapable('cloudflare', id);
        pushUnique({
          id,
          label: id.replace(/^@cf\/[^/]+\//, ''),
          supportsVision,
          isFree: true,
          tier: 'freemium',
          pricingNoteAr: supportsVision ? 'يدعم الصور · حصة مجانية' : 'نصي فقط · حصة مجانية',
          pricingNoteEn: supportsVision ? 'Vision · Free daily Neurons' : 'Text · Free daily Neurons',
        });
      }
    }
  } else {
    // OpenAI-compatible /models (OpenRouter, Groq, DeepSeek, Qwen)
    const items = Array.isArray((rawJson as { data?: unknown[] })?.data)
      ? ((rawJson as {
          data: Array<{
            id?: string;
            name?: string;
            architecture?: { modality?: string; input_modalities?: string[] };
            pricing?: { prompt?: string | number; completion?: string | number };
          }>;
        }).data)
      : [];

    for (const item of items) {
      const id = String(item.id || '').trim();
      if (!id) continue;
      if (providerId === 'openrouter' && DEPRECATED_GEMINI_PATTERN.test(id)) continue;

      const known = curatedMap.get(id);
      if (known) {
        pushUnique(known);
        continue;
      }

      let supportsVision = isModelVisionCapable(providerId, id);
      if (item.architecture) {
        const inputs = item.architecture.input_modalities || [];
        const modality = String(item.architecture.modality || '').toLowerCase();
        if (inputs.includes('image') || modality.includes('image')) {
          supportsVision = true;
        }
      }

      let isFree = !isModelPaid(providerId, id);
      if (providerId === 'openrouter' && item.pricing) {
        const p = Number(item.pricing.prompt ?? 1);
        const c = Number(item.pricing.completion ?? 1);
        isFree = p === 0 && c === 0;
      }

      pushUnique({
        id,
        label: item.name || id,
        supportsVision,
        isFree,
        tier: isFree ? (providerId === 'openrouter' ? 'free' : 'freemium') : 'paid',
        pricingNoteAr: `${supportsVision ? 'يدعم الصور' : 'نصي فقط'} · ${isFree ? 'مجاني' : 'مدفوع'}`,
        pricingNoteEn: `${supportsVision ? 'Vision' : 'Text-only'} · ${isFree ? 'Free' : 'Paid'}`,
      });
    }
  }

  // Ensure curated defaults stay available if dynamic response returned subset or empty
  for (const m of curated) {
    pushUnique(m);
  }

  // Put free + vision models high for OpenRouter if list is huge, cap at 120 items
  if (result.length > 120) {
    result.sort((a, b) => {
      const score = (m: ProviderModelMeta) =>
        (curatedMap.has(m.id) ? 8 : 0) + (m.isFree ? 4 : 0) + (m.supportsVision ? 2 : 0);
      return score(b) - score(a);
    });
    return result.slice(0, 120);
  }
  return result;
}
