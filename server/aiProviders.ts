import zlib from 'zlib';
import type {
  AiProviderId,
  AiSettings,
  ComicFormat,
  GlossaryEntry,
  Page,
  Project,
  ProviderEndpointConfig,
  ProviderModelMeta,
  ProvidersDetailedStatusMap,
  ProvidersStatusMap,
  ProviderTestResult,
  ReadingDirection,
  StoryMemory,
  TextRegion,
  TranslationStyle,
} from '../src/types/domain.ts';
import { GeminiUpstreamError } from './geminiResilience.ts';
import {
  analyzeComicPage,
  buildAnalyzedPageResult,
  buildComicAnalysisPrompt,
  buildComicTranslationInstruction,
  resolveGeminiApiKey,
  resolveImageBase64,
  retranslateSingleBubble,
  testAiConnection,
  translateRegionsWithContext,
} from './geminiService.ts';
import {
  ALL_PROVIDER_IDS,
  DEFAULT_CLOUDFLARE_ENDPOINT_TEMPLATE,
  DEFAULT_DEEPSEEK_ENDPOINT,
  DEFAULT_GEMINI_ENDPOINT,
  DEFAULT_GROQ_ENDPOINT,
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_QWEN_CN_ENDPOINT,
  DEFAULT_QWEN_INTL_ENDPOINT,
  extractCloudflareAccountId,
  isModelPaid,
  isModelVisionCapable,
  parseDynamicModelsResponse,
  PROVIDER_CATALOG,
  resolveCloudflareEndpoint,
} from './providerCatalog.ts';
import { getVaultSecret, maskApiKey, redactSecrets } from './secretVault.ts';

export {
  DEFAULT_CLOUDFLARE_ENDPOINT_TEMPLATE,
  DEFAULT_DEEPSEEK_ENDPOINT,
  DEFAULT_GEMINI_ENDPOINT,
  DEFAULT_GROQ_ENDPOINT,
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_QWEN_CN_ENDPOINT,
  DEFAULT_QWEN_INTL_ENDPOINT,
};

export const PROVIDER_DEFAULT_MODELS: Record<AiProviderId, ProviderEndpointConfig> = {
  gemini: {
    translationModel: PROVIDER_CATALOG.gemini.defaultTranslationModel,
    visionModel: PROVIDER_CATALOG.gemini.defaultVisionModel,
    endpointUrl: PROVIDER_CATALOG.gemini.defaultEndpointUrl,
  },
  groq: {
    translationModel: PROVIDER_CATALOG.groq.defaultTranslationModel,
    visionModel: PROVIDER_CATALOG.groq.defaultVisionModel,
    endpointUrl: PROVIDER_CATALOG.groq.defaultEndpointUrl,
  },
  openrouter: {
    translationModel: PROVIDER_CATALOG.openrouter.defaultTranslationModel,
    visionModel: PROVIDER_CATALOG.openrouter.defaultVisionModel,
    endpointUrl: PROVIDER_CATALOG.openrouter.defaultEndpointUrl,
  },
  cloudflare: {
    translationModel: PROVIDER_CATALOG.cloudflare.defaultTranslationModel,
    visionModel: PROVIDER_CATALOG.cloudflare.defaultVisionModel,
    endpointUrl: PROVIDER_CATALOG.cloudflare.defaultEndpointUrl,
    accountId: '',
  },
  deepseek: {
    translationModel: PROVIDER_CATALOG.deepseek.defaultTranslationModel,
    endpointUrl: PROVIDER_CATALOG.deepseek.defaultEndpointUrl,
  },
  qwen_studio: {
    translationModel: PROVIDER_CATALOG.qwen_studio.defaultTranslationModel,
    visionModel: PROVIDER_CATALOG.qwen_studio.defaultVisionModel,
    endpointUrl: PROVIDER_CATALOG.qwen_studio.defaultEndpointUrl,
  },
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'gemini',
  visionProvider: 'gemini',
  translationModel: 'gemini-4-hydrogen',
  visionOcrModel: 'gemini-4-hydrogen',
  inpaintingEngine: 'telea_biharmonic',
  creativity: 0.35,
  fidelity: 0.85,
  parallelPages: 2,
  rateLimitPerMinute: 30,
  autoFallback: true,
  allowPaidFallback: false,
  fallbackOrder: ['gemini', 'groq', 'openrouter', 'cloudflare', 'deepseek', 'qwen_studio'],
  providers: {
    gemini: { ...PROVIDER_DEFAULT_MODELS.gemini },
    groq: { ...PROVIDER_DEFAULT_MODELS.groq },
    openrouter: { ...PROVIDER_DEFAULT_MODELS.openrouter },
    cloudflare: { ...PROVIDER_DEFAULT_MODELS.cloudflare },
    deepseek: { ...PROVIDER_DEFAULT_MODELS.deepseek },
    qwen_studio: { ...PROVIDER_DEFAULT_MODELS.qwen_studio },
  },
};

export function isValidAiProviderId(raw?: string): raw is AiProviderId {
  return ALL_PROVIDER_IDS.includes(raw as AiProviderId);
}

export function normalizeAiProviderId(raw?: string): AiProviderId {
  if (isValidAiProviderId(raw)) return raw;
  return 'gemini';
}

export function normalizeAiSettings(raw?: Partial<AiSettings> | null): AiSettings {
  const src = raw || {};
  const provider =
    isValidAiProviderId(src.provider) ||
    src.provider === 'openai_compatible' ||
    src.provider === 'anthropic_compatible' ||
    src.provider === 'local'
      ? src.provider
      : 'gemini';

  const visionProvider: AiProviderId =
    isValidAiProviderId(src.visionProvider) && PROVIDER_CATALOG[src.visionProvider].supportsVision
      ? src.visionProvider
      : 'gemini';

  const providers: Record<AiProviderId, ProviderEndpointConfig> = {
    gemini: {
      translationModel:
        src.providers?.gemini?.translationModel ||
        (provider === 'gemini' && src.translationModel
          ? src.translationModel
          : PROVIDER_DEFAULT_MODELS.gemini.translationModel),
      visionModel:
        src.providers?.gemini?.visionModel ||
        (visionProvider === 'gemini' && src.visionOcrModel
          ? src.visionOcrModel
          : PROVIDER_DEFAULT_MODELS.gemini.visionModel),
      endpointUrl: src.providers?.gemini?.endpointUrl || PROVIDER_DEFAULT_MODELS.gemini.endpointUrl,
    },
    groq: {
      translationModel:
        src.providers?.groq?.translationModel ||
        (provider === 'groq' && src.translationModel
          ? src.translationModel
          : PROVIDER_DEFAULT_MODELS.groq.translationModel),
      visionModel:
        src.providers?.groq?.visionModel ||
        (visionProvider === 'groq' && src.visionOcrModel
          ? src.visionOcrModel
          : PROVIDER_DEFAULT_MODELS.groq.visionModel),
      endpointUrl: src.providers?.groq?.endpointUrl || PROVIDER_DEFAULT_MODELS.groq.endpointUrl,
    },
    openrouter: {
      translationModel:
        src.providers?.openrouter?.translationModel ||
        (provider === 'openrouter' && src.translationModel
          ? src.translationModel
          : PROVIDER_DEFAULT_MODELS.openrouter.translationModel),
      visionModel:
        src.providers?.openrouter?.visionModel ||
        (visionProvider === 'openrouter' && src.visionOcrModel
          ? src.visionOcrModel
          : PROVIDER_DEFAULT_MODELS.openrouter.visionModel),
      endpointUrl:
        src.providers?.openrouter?.endpointUrl || PROVIDER_DEFAULT_MODELS.openrouter.endpointUrl,
    },
    cloudflare: (() => {
      const rawUrl = src.providers?.cloudflare?.endpointUrl || PROVIDER_DEFAULT_MODELS.cloudflare.endpointUrl;
      const accountId =
        src.providers?.cloudflare?.accountId?.trim() || extractCloudflareAccountId(rawUrl);
      return {
        translationModel:
          src.providers?.cloudflare?.translationModel ||
          (provider === 'cloudflare' && src.translationModel
            ? src.translationModel
            : PROVIDER_DEFAULT_MODELS.cloudflare.translationModel),
        visionModel:
          src.providers?.cloudflare?.visionModel ||
          (visionProvider === 'cloudflare' && src.visionOcrModel
            ? src.visionOcrModel
            : PROVIDER_DEFAULT_MODELS.cloudflare.visionModel),
        accountId,
        endpointUrl: resolveCloudflareEndpoint(accountId, rawUrl),
      };
    })(),
    deepseek: {
      translationModel:
        src.providers?.deepseek?.translationModel ||
        (provider === 'deepseek' && src.translationModel
          ? src.translationModel
          : PROVIDER_DEFAULT_MODELS.deepseek.translationModel),
      endpointUrl: src.providers?.deepseek?.endpointUrl || PROVIDER_DEFAULT_MODELS.deepseek.endpointUrl,
    },
    qwen_studio: {
      translationModel:
        src.providers?.qwen_studio?.translationModel ||
        (provider === 'qwen_studio' && src.translationModel
          ? src.translationModel
          : PROVIDER_DEFAULT_MODELS.qwen_studio.translationModel),
      visionModel:
        src.providers?.qwen_studio?.visionModel ||
        (visionProvider === 'qwen_studio' && src.visionOcrModel
          ? src.visionOcrModel
          : PROVIDER_DEFAULT_MODELS.qwen_studio.visionModel),
      endpointUrl:
        src.providers?.qwen_studio?.endpointUrl || PROVIDER_DEFAULT_MODELS.qwen_studio.endpointUrl,
    },
  };

  const activeId = normalizeAiProviderId(provider);
  const rawOrder = Array.isArray(src.fallbackOrder)
    ? src.fallbackOrder.filter((p): p is AiProviderId => isValidAiProviderId(p))
    : [];
  const fallbackOrder: AiProviderId[] = Array.from(
    new Set<AiProviderId>([...rawOrder, ...ALL_PROVIDER_IDS])
  );

  return {
    provider,
    visionProvider,
    translationModel: src.translationModel || providers[activeId].translationModel,
    visionOcrModel:
      src.visionOcrModel ||
      providers[visionProvider].visionModel ||
      PROVIDER_DEFAULT_MODELS.gemini.visionModel!,
    inpaintingEngine: src.inpaintingEngine || 'telea_biharmonic',
    creativity: typeof src.creativity === 'number' ? src.creativity : 0.35,
    fidelity: typeof src.fidelity === 'number' ? src.fidelity : 0.85,
    parallelPages: typeof src.parallelPages === 'number' ? src.parallelPages : 2,
    rateLimitPerMinute: typeof src.rateLimitPerMinute === 'number' ? src.rateLimitPerMinute : 30,
    customEndpointUrl: src.customEndpointUrl,
    autoFallback: src.autoFallback !== false,
    allowPaidFallback: Boolean(src.allowPaidFallback),
    fallbackOrder,
    providers,
  };
}

function getEnvApiKeyForProvider(
  provider: AiProviderId,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  switch (provider) {
    case 'gemini': {
      const k = env.GEMINI_API_KEY?.trim();
      return k && k !== 'MY_GEMINI_API_KEY' ? k : undefined;
    }
    case 'groq': {
      const k = env.GROQ_API_KEY?.trim();
      return k && k !== 'MY_GROQ_API_KEY' ? k : undefined;
    }
    case 'openrouter': {
      const k = env.OPENROUTER_API_KEY?.trim();
      return k && k !== 'MY_OPENROUTER_API_KEY' ? k : undefined;
    }
    case 'cloudflare': {
      const k = (env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY)?.trim();
      return k && k !== 'MY_CLOUDFLARE_API_TOKEN' ? k : undefined;
    }
    case 'deepseek': {
      const k = env.DEEPSEEK_API_KEY?.trim();
      return k && k !== 'MY_DEEPSEEK_API_KEY' ? k : undefined;
    }
    case 'qwen_studio': {
      const k = (env.QWEN_API_KEY || env.DASHSCOPE_API_KEY)?.trim();
      return k && k !== 'MY_QWEN_API_KEY' ? k : undefined;
    }
  }
}

export function getProviderApiKey(
  provider: AiProviderId,
  env: NodeJS.ProcessEnv = process.env,
  explicitKey?: string
): string | undefined {
  const manual = explicitKey?.trim();
  if (manual && !manual.startsWith('MY_')) return manual;

  if (provider === 'gemini') {
    const vault = getVaultSecret('gemini')?.apiKey?.trim();
    if (vault && vault !== 'MY_GEMINI_API_KEY') return vault;
    return getEnvApiKeyForProvider('gemini', env);
  }

  const vault = getVaultSecret(provider)?.apiKey?.trim();
  if (vault && !vault.startsWith('MY_')) return vault;
  return getEnvApiKeyForProvider(provider, env);
}

export function getProviderAccountId(
  provider: AiProviderId,
  settings?: AiSettings,
  explicitAccountId?: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (provider !== 'cloudflare') return undefined;
  const fromExplicit = explicitAccountId?.trim();
  if (fromExplicit) return fromExplicit;
  const fromVault = getVaultSecret('cloudflare')?.accountId?.trim();
  if (fromVault) return fromVault;
  const fromSettings =
    settings?.providers?.cloudflare?.accountId?.trim() ||
    extractCloudflareAccountId(settings?.providers?.cloudflare?.endpointUrl);
  if (fromSettings) return fromSettings;
  const fromEnv = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return fromEnv || undefined;
}

export function getProvidersStatus(env: NodeJS.ProcessEnv = process.env): ProvidersStatusMap {
  return {
    gemini: Boolean(resolveGeminiApiKey() || getEnvApiKeyForProvider('gemini', env)),
    groq: Boolean(getProviderApiKey('groq', env)),
    openrouter: Boolean(getProviderApiKey('openrouter', env)),
    cloudflare: Boolean(getProviderApiKey('cloudflare', env)),
    deepseek: Boolean(getProviderApiKey('deepseek', env)),
    qwen_studio: Boolean(getProviderApiKey('qwen_studio', env)),
  };
}

export function getProvidersDetailedStatus(
  settings?: AiSettings,
  env: NodeJS.ProcessEnv = process.env
): ProvidersDetailedStatusMap {
  const result = {} as ProvidersDetailedStatusMap;
  for (const id of ALL_PROVIDER_IDS) {
    const vault = getVaultSecret(id);
    const envKey = getEnvApiKeyForProvider(id, env);
    if (vault?.apiKey) {
      const accountId = id === 'cloudflare' ? getProviderAccountId(id, settings, undefined, env) : undefined;
      result[id] = {
        configured: true,
        source: 'vault',
        maskedHint: maskApiKey(vault.apiKey),
        ...(id === 'cloudflare'
          ? { hasAccountId: Boolean(accountId), accountIdHint: maskApiKey(accountId) }
          : {}),
      };
    } else if (envKey) {
      const accountId = id === 'cloudflare' ? getProviderAccountId(id, settings, undefined, env) : undefined;
      result[id] = {
        configured: true,
        source: 'env',
        maskedHint: maskApiKey(envKey),
        ...(id === 'cloudflare'
          ? { hasAccountId: Boolean(accountId), accountIdHint: maskApiKey(accountId) }
          : {}),
      };
    } else {
      result[id] = {
        configured: false,
        source: 'none',
        ...(id === 'cloudflare'
          ? {
              hasAccountId: Boolean(getProviderAccountId(id, settings, undefined, env)),
            }
          : {}),
      };
    }
  }
  return result;
}

export function getProviderSecretName(provider: AiProviderId): string {
  return PROVIDER_CATALOG[provider].secretEnvVar;
}

export function validateEndpointUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.includes('{ACCOUNT_ID}')) {
    throw new GeminiUpstreamError(
      'يرجى إدخال Cloudflare Account ID أو استبدال {ACCOUNT_ID} في رابط نقطة النهاية.',
      {
        httpStatus: 400,
        code: 'INVALID_ARGUMENT',
        retryable: false,
        upstreamStatus: 'MISSING_ACCOUNT_ID',
        attemptedModels: [trimmed],
      }
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GeminiUpstreamError(`رابط نقطة النهاية غير صالح: ${rawUrl}`, {
      httpStatus: 400,
      code: 'INVALID_ARGUMENT',
      retryable: false,
      upstreamStatus: 'INVALID_ENDPOINT',
      attemptedModels: [rawUrl],
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GeminiUpstreamError('يجب أن يبدأ رابط نقطة النهاية بـ https:// أو http://', {
      httpStatus: 400,
      code: 'INVALID_ARGUMENT',
      retryable: false,
      upstreamStatus: 'INVALID_ENDPOINT',
      attemptedModels: [rawUrl],
    });
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host === 'metadata.google.internal'
  ) {
    throw new GeminiUpstreamError('عنوان الشبكة غير مسموح به لنقاط النهاية.', {
      httpStatus: 400,
      code: 'PERMISSION_DENIED',
      retryable: false,
      upstreamStatus: 'BLOCKED_ENDPOINT',
      attemptedModels: [rawUrl],
    });
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function resolveProviderEndpoint(
  provider: AiProviderId,
  settings?: AiSettings,
  explicitEndpoint?: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitAccountId?: string
): string {
  if (provider === 'gemini') {
    const raw =
      (explicitEndpoint && explicitEndpoint.trim()) ||
      settings?.providers?.gemini?.endpointUrl?.trim() ||
      PROVIDER_DEFAULT_MODELS.gemini.endpointUrl;
    return validateEndpointUrl(raw);
  }

  if (provider === 'cloudflare') {
    const acctId = getProviderAccountId('cloudflare', settings, explicitAccountId, env);
    const candidate =
      (explicitEndpoint && explicitEndpoint.trim()) ||
      settings?.providers?.cloudflare?.endpointUrl?.trim() ||
      env.CLOUDFLARE_BASE_URL?.trim() ||
      DEFAULT_CLOUDFLARE_ENDPOINT_TEMPLATE;
    const resolved = resolveCloudflareEndpoint(acctId, candidate);
    return validateEndpointUrl(resolved);
  }

  const fromSettings = settings?.providers?.[provider]?.endpointUrl;
  const fromEnv =
    provider === 'groq'
      ? env.GROQ_BASE_URL
      : provider === 'openrouter'
      ? env.OPENROUTER_BASE_URL
      : provider === 'deepseek'
      ? env.DEEPSEEK_BASE_URL
      : env.QWEN_BASE_URL || env.DASHSCOPE_BASE_URL;

  const raw =
    (explicitEndpoint && explicitEndpoint.trim()) ||
    (fromSettings && fromSettings.trim()) ||
    (fromEnv && fromEnv.trim()) ||
    PROVIDER_DEFAULT_MODELS[provider].endpointUrl;
  return validateEndpointUrl(raw);
}

/**
 * Extracts a JSON object string from raw LLM output, stripping DeepSeek/Qwen <think> blocks
 * and Markdown ```json fences if present.
 */
export function extractJsonFromModelText(raw: string): string {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : withoutThink).trim();
  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    return candidate;
  }
  const firstObj = candidate.indexOf('{');
  const lastObj = candidate.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    return candidate.slice(firstObj, lastObj + 1);
  }
  return candidate;
}

export type OpenAiMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

export function buildOpenAiChatPayload(params: {
  provider: Exclude<AiProviderId, 'gemini'>;
  model: string;
  systemPrompt?: string;
  userContent: OpenAiMessageContent;
  expectJson?: boolean;
  temperature?: number;
}) {
  const { provider, model, systemPrompt, userContent, expectJson = true, temperature } = params;
  const messages: Array<{ role: 'system' | 'user'; content: OpenAiMessageContent }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userContent });

  const isReasoner =
    (provider === 'deepseek' && model.includes('reasoner')) ||
    model.toLowerCase().includes('qwq') ||
    model.toLowerCase().includes('deepseek-r1');
  const hasImagePart = Array.isArray(userContent) && userContent.some((p) => p.type === 'image_url');
  const isVision =
    hasImagePart ||
    model.includes('-vl') ||
    model.toLowerCase().includes('vision') ||
    model.toLowerCase().includes('llava');

  const body: Record<string, unknown> = {
    model,
    messages,
  };

  if (typeof temperature === 'number' && !isReasoner) {
    body.temperature = Math.max(0, Math.min(1, temperature));
  }

  // OpenAI-compatible JSON mode works reliably on DeepSeek chat, Groq text models, OpenRouter text models;
  // skip on reasoning/vision/Cloudflare models where response_format can be rejected
  if (expectJson && !isReasoner && !isVision && provider !== 'cloudflare') {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callOpenAiCompatibleChat(params: {
  provider: Exclude<AiProviderId, 'gemini'>;
  model: string;
  endpointUrl: string;
  apiKey?: string;
  systemPrompt?: string;
  userContent: OpenAiMessageContent;
  expectJson?: boolean;
  temperature?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; model: string }> {
  const {
    provider,
    model,
    endpointUrl,
    apiKey = getProviderApiKey(provider),
    systemPrompt,
    userContent,
    expectJson = true,
    temperature,
    maxRetries = 2,
    fetchImpl = fetch,
  } = params;

  const providerLabel = PROVIDER_CATALOG[provider].name;
  const secretName = getProviderSecretName(provider);

  if (!apiKey) {
    throw new GeminiUpstreamError(
      `مفتاح ${providerLabel} غير مُعدّ. أضفه من بطاقة المزود في الإعدادات أو عبر ${secretName}.`,
      {
        httpStatus: 400,
        code: 'API_KEY_INVALID',
        retryable: false,
        upstreamStatus: 'API_KEY_MISSING',
        attemptedModels: [`${provider}:${model}`],
      }
    );
  }

  const base = validateEndpointUrl(endpointUrl);
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const payload = buildOpenAiChatPayload({
    provider,
    model,
    systemPrompt,
    userContent,
    expectJson,
    temperature,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
    headers['X-Title'] = 'Faqqa Comic Translator';
  }

  let lastErr: GeminiUpstreamError | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });

      const rawText = await res.text();
      if (!res.ok) {
        let detail = rawText;
        try {
          const parsed = JSON.parse(rawText) as {
            error?: { message?: string } | string;
            errors?: Array<{ message?: string }>;
            message?: string;
          };
          detail =
            (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ||
            parsed.errors?.[0]?.message ||
            parsed.message ||
            rawText;
        } catch {
          // keep rawText
        }

        const safeDetail = redactSecrets(String(detail), [apiKey]).slice(0, 220);
        const retryable =
          res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;

        const message =
          res.status === 401 || res.status === 403
            ? `رفض ${providerLabel} مفتاح API (${res.status}). تحقق من صحة المفتاح أو الصلاحيات.`
            : res.status === 402
            ? `يتطلب هذا النموذج رصيداً مدفوعاً في ${providerLabel} (402). اختر نموذجاً مجانياً أو اشحن الرصيد.`
            : res.status === 404
            ? `النموذج أو المسار غير موجود في ${providerLabel} (404): ${safeDetail}`
            : res.status === 429
            ? `تم تجاوز حد الطلبات أو الحصة في ${providerLabel} (429). يرجى الانتظار أو التبديل لمزود آخر.`
            : res.status >= 500
            ? `خدمة ${providerLabel} تواجه ضغطاً مؤقتاً (${res.status}).`
            : `${providerLabel} (${res.status}): ${safeDetail}`;

        const errCode =
          res.status === 401 || res.status === 403
            ? 'PERMISSION_DENIED'
            : res.status === 429 || res.status === 402
            ? 'RESOURCE_EXHAUSTED'
            : res.status === 404
            ? 'NOT_FOUND'
            : res.status >= 500
            ? 'UNAVAILABLE'
            : 'UPSTREAM_ERROR';

        lastErr = new GeminiUpstreamError(message, {
          httpStatus: res.status,
          code: errCode,
          retryable,
          upstreamStatus: `HTTP_${res.status}`,
          attemptedModels: [`${provider}:${model}`],
        });

        if (retryable && attempt < maxRetries) {
          await sleep(500 * attempt);
          continue;
        }
        throw lastErr;
      }

      const data = JSON.parse(rawText) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
        result?: { response?: string };
      };
      const content = data.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content.map((c) => c.text || '').join('\n')
        : content || data.result?.response || '';

      return {
        text: text.trim(),
        model: data.model || model,
      };
    } catch (err) {
      if (err instanceof GeminiUpstreamError) {
        if (!err.retryable || attempt >= maxRetries) throw err;
        lastErr = err;
        await sleep(500 * attempt);
        continue;
      }
      const msg = redactSecrets(err instanceof Error ? err.message : String(err), [apiKey]);
      lastErr = new GeminiUpstreamError(`تعذر الاتصال بخادم ${providerLabel}: ${msg}`, {
        httpStatus: 503,
        code: 'NETWORK_ERROR',
        retryable: true,
        upstreamStatus: 'NETWORK_ERROR',
        attemptedModels: [`${provider}:${model}`],
      });
      if (attempt < maxRetries) {
        await sleep(500 * attempt);
        continue;
      }
      throw lastErr;
    }
  }

  throw (
    lastErr ||
    new GeminiUpstreamError(`تعذر إكمال الطلب عبر ${providerLabel}.`, {
      httpStatus: 503,
      code: 'UNAVAILABLE',
      retryable: true,
      upstreamStatus: 'UNAVAILABLE',
      attemptedModels: [`${provider}:${model}`],
    })
  );
}

/**
 * Generates a small valid high-contrast RGBA PNG (48x20) in memory for real Vision API transmission tests.
 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function generateTestVisionPngBase64(): string {
  const width = 48;
  const height = 20;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter none
    for (let x = 0; x < width; x++) {
      // Draw high-contrast white background with bold dark "HI" block letters
      const inHLeft = x >= 8 && x <= 10 && y >= 4 && y <= 15;
      const inHBar = x >= 10 && x <= 18 && y >= 9 && y <= 11;
      const inHRight = x >= 18 && x <= 20 && y >= 4 && y <= 15;
      const inI = x >= 28 && x <= 31 && y >= 4 && y <= 15;
      const isInk = inHLeft || inHBar || inHRight || inI;
      const val = isInk ? 20 : 250;
      const idx = 1 + x * 3;
      row[idx] = val;
      row[idx + 1] = val;
      row[idx + 2] = val;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

export async function fetchDynamicProviderModels(params: {
  provider: AiProviderId;
  apiKey?: string;
  endpointUrl?: string;
  accountId?: string;
  settings?: AiSettings;
  fetchImpl?: typeof fetch;
}): Promise<{ models: ProviderModelMeta[]; source: 'live' | 'catalog'; warning?: string }> {
  const { provider, settings, fetchImpl = fetch } = params;
  const catalog = PROVIDER_CATALOG[provider];
  const apiKey = getProviderApiKey(provider, process.env, params.apiKey);

  // OpenRouter public /models works even without a key; other providers need key
  if (!apiKey && provider !== 'openrouter') {
    return {
      models: catalog.models,
      source: 'catalog',
      warning: 'أدخل مفتاح API لجلب قائمة النماذج المباشرة من المزود.',
    };
  }

  try {
    if (provider === 'gemini') {
      const endpoint = resolveProviderEndpoint('gemini', settings, params.endpointUrl);
      const url = `${endpoint}/v1beta/models?key=${encodeURIComponent(apiKey!)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      return {
        models: parseDynamicModelsResponse('gemini', json),
        source: 'live',
      };
    }

    if (provider === 'cloudflare') {
      const accountId = getProviderAccountId('cloudflare', settings, params.accountId);
      if (!accountId) {
        return {
          models: catalog.models,
          source: 'catalog',
          warning: 'أدخل Cloudflare Account ID لجلب نماذج Workers AI.',
        };
      }
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        accountId
      )}/ai/models/search?per_page=100`;
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      return {
        models: parseDynamicModelsResponse('cloudflare', json),
        source: 'live',
      };
    }

    const endpoint = resolveProviderEndpoint(provider, settings, params.endpointUrl);
    const url = `${endpoint.replace(/\/chat\/completions$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    return {
      models: parseDynamicModelsResponse(provider, json),
      source: 'live',
    };
  } catch (err) {
    const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err), [apiKey || '']);
    return {
      models: catalog.models,
      source: 'catalog',
      warning: `تعذر تحديث القائمة المباشرة (${safeMsg}) — تم عرض النماذج المعتمدة.`,
    };
  }
}

export async function testProviderConnection(params: {
  provider?: AiProviderId;
  model?: string;
  visionModel?: string;
  endpointUrl?: string;
  accountId?: string;
  apiKey?: string;
  testVision?: boolean;
  settings?: AiSettings;
  fetchImpl?: typeof fetch;
}): Promise<ProviderTestResult> {
  const provider = normalizeAiProviderId(params.provider || params.settings?.provider);
  const start = Date.now();
  const catalog = PROVIDER_CATALOG[provider];
  const testVisionPngBase64 = params.testVision ? generateTestVisionPngBase64() : undefined;

  if (provider === 'gemini') {
    const model =
      params.model ||
      params.settings?.providers?.gemini?.translationModel ||
      params.settings?.translationModel ||
      PROVIDER_DEFAULT_MODELS.gemini.translationModel;
    const visionModel =
      params.visionModel ||
      params.settings?.providers?.gemini?.visionModel ||
      PROVIDER_DEFAULT_MODELS.gemini.visionModel;
    const apiKey = getProviderApiKey('gemini', process.env, params.apiKey);
    const res = await testAiConnection(model, {
      apiKey,
      endpointUrl: params.endpointUrl || params.settings?.providers?.gemini?.endpointUrl,
      visionModel,
      testVisionPngBase64,
    });
    return { ...res, provider: 'gemini' };
  }

  const model =
    params.model ||
    params.settings?.providers?.[provider]?.translationModel ||
    PROVIDER_DEFAULT_MODELS[provider].translationModel;
  const endpointUrl = resolveProviderEndpoint(
    provider,
    params.settings,
    params.endpointUrl,
    process.env,
    params.accountId
  );
  const apiKey = getProviderApiKey(provider, process.env, params.apiKey);

  // Real translation probe (does not treat key acceptance alone as translation success)
  const trRes = await callOpenAiCompatibleChat({
    provider,
    model,
    endpointUrl,
    apiKey,
    userContent:
      'Translate this short comic dialogue into Arabic and reply ONLY with the Arabic text: "Hold the line!"',
    expectJson: false,
    temperature: 0,
    maxRetries: 1,
    fetchImpl: params.fetchImpl,
  });

  const translationVerified = Boolean(trRes.text && trRes.text.trim().length > 0);
  if (!translationVerified) {
    throw new GeminiUpstreamError(
      `استجاب ${catalog.name} للطلب لكنه أعاد ترجمة فارغة.`,
      {
        httpStatus: 502,
        code: 'UPSTREAM_ERROR',
        retryable: false,
        upstreamStatus: 'EMPTY_TRANSLATION',
        attemptedModels: [`${provider}:${model}`],
      }
    );
  }

  let visionVerified: boolean | undefined;
  let visionMessage: string | undefined;
  let testedVisionModel: string | undefined;

  if (params.testVision && catalog.supportsVision) {
    const vModel =
      params.visionModel ||
      params.settings?.providers?.[provider]?.visionModel ||
      catalog.defaultVisionModel ||
      model;
    testedVisionModel = vModel;

    if (!isModelVisionCapable(provider, vModel)) {
      visionVerified = false;
      visionMessage = `النموذج ${vModel} مخصص للنصوص فقط ولا يدعم استقبال الصور.`;
    } else {
      const pngBase64 = testVisionPngBase64!;
      const vRes = await callOpenAiCompatibleChat({
        provider,
        model: vModel,
        endpointUrl,
        apiKey,
        userContent: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${pngBase64}` },
          },
          {
            type: 'text',
            text: 'Confirm you can read this test PNG image and respond with a brief confirmation.',
          },
        ],
        expectJson: false,
        temperature: 0,
        maxRetries: 1,
        fetchImpl: params.fetchImpl,
      });
      visionVerified = Boolean(vRes.text && vRes.text.trim().length > 0);
      visionMessage = vRes.text || 'Vision OK';
    }
  }

  return {
    ok: translationVerified && (visionVerified !== false),
    provider,
    model: trRes.model,
    visionModel: testedVisionModel,
    translationVerified,
    visionVerified,
    latencyMs: Date.now() - start,
    message: trRes.text,
    visionMessage,
  };
}

export async function analyzeComicPageWithOpenAiVision(
  provider: Exclude<AiProviderId, 'gemini'>,
  page: Page,
  readingDirection: ReadingDirection,
  settings: AiSettings,
  options?: { targetLanguage?: string; comicFormat?: ComicFormat }
): Promise<{ panels: Page['panels']; regions: TextRegion[]; modelUsed: string }> {
  const { base64, mimeType } = resolveImageBase64(page.originalImage);
  const comicFormat = options?.comicFormat || 'superhero';
  const targetLanguage = options?.targetLanguage || 'ar';
  const systemInstruction = `${buildComicAnalysisPrompt(readingDirection, comicFormat)}

Respond ONLY with valid JSON matching this exact structure:
{
  "panels": [{"x": number, "y": number, "width": number, "height": number}],
  "regions": [{"regionType": "dialogue"|"narration"|"sfx"|"outside", "x": number, "y": number, "width": number, "height": number, "originalText": string, "sourceLanguage": string, "confidence": number, "speaker": string, "isDarkBackground": boolean}]
}`;

  const model =
    settings.providers?.[provider]?.visionModel ||
    PROVIDER_CATALOG[provider].defaultVisionModel ||
    settings.visionOcrModel;
  const endpointUrl = resolveProviderEndpoint(provider, settings);

  const res = await callOpenAiCompatibleChat({
    provider,
    model,
    endpointUrl,
    systemPrompt: systemInstruction,
    userContent: [
      {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${base64}` },
      },
      {
        type: 'text',
        text: `Analyze this comic page (reading direction: ${readingDirection}). Return JSON with panels and regions using normalized 0..1000 coordinates.`,
      },
    ],
    expectJson: false,
    temperature: 0.1,
  });

  const parsed = JSON.parse(extractJsonFromModelText(res.text || '{"panels":[],"regions":[]}'));
  const analyzed = buildAnalyzedPageResult(
    page,
    parsed,
    readingDirection,
    targetLanguage,
    comicFormat
  );
  return { ...analyzed, modelUsed: res.model };
}

// Backward-compatible export name
export async function analyzeComicPageWithQwen(
  page: Page,
  readingDirection: ReadingDirection,
  settings: AiSettings,
  options?: { targetLanguage?: string; comicFormat?: ComicFormat }
): Promise<{ panels: Page['panels']; regions: TextRegion[] }> {
  const res = await analyzeComicPageWithOpenAiVision(
    'qwen_studio',
    page,
    readingDirection,
    settings,
    options
  );
  return { panels: res.panels, regions: res.regions };
}

export function buildVisionExecutionOrder(
  settings: AiSettings,
  statusMap: ProvidersStatusMap = getProvidersStatus()
): AiProviderId[] {
  const normalized = normalizeAiSettings(settings);
  const requested = normalized.visionProvider || 'gemini';
  const primary: AiProviderId = PROVIDER_CATALOG[requested]?.supportsVision ? requested : 'gemini';
  const primaryModel =
    normalized.providers?.[primary]?.visionModel ||
    PROVIDER_CATALOG[primary].defaultVisionModel ||
    normalized.visionOcrModel;

  const order: AiProviderId[] = [];
  if (isModelVisionCapable(primary, primaryModel)) {
    order.push(primary);
  }
  if (!normalized.autoFallback && order.length > 0) return order;

  for (const cand of normalized.fallbackOrder || ALL_PROVIDER_IDS) {
    if (order.includes(cand)) continue;
    if (!PROVIDER_CATALOG[cand].supportsVision) continue;
    if (!statusMap[cand]) continue;

    const candModel =
      normalized.providers?.[cand]?.visionModel || PROVIDER_CATALOG[cand].defaultVisionModel || '';
    if (!candModel || !isModelVisionCapable(cand, candModel)) continue;
    if (!normalized.allowPaidFallback && isModelPaid(cand, candModel)) continue;
    order.push(cand);
  }

  return order.length > 0 ? order : ['gemini'];
}

export async function analyzeComicPageWithProvider(
  page: Page,
  readingDirection: ReadingDirection,
  settings: AiSettings,
  options?: { targetLanguage?: string; comicFormat?: ComicFormat },
  deps?: {
    runGeminiVision?: typeof analyzeComicPage;
    runQwenVision?: typeof analyzeComicPageWithQwen;
    runOpenAiVision?: typeof analyzeComicPageWithOpenAiVision;
    statusMap?: ProvidersStatusMap;
  }
): Promise<{
  panels: Page['panels'];
  regions: TextRegion[];
  providerUsed: AiProviderId;
  modelUsed: string;
}> {
  const normalized = normalizeAiSettings(settings);
  const status = deps?.statusMap || getProvidersStatus();
  const candidates = buildVisionExecutionOrder(normalized, status);

  let lastErr: unknown;
  for (const prov of candidates) {
    if (prov !== candidates[0] && !status[prov]) continue;
    try {
      if (prov === 'gemini') {
        const modelUsed =
          normalized.providers?.gemini?.visionModel ||
          normalized.visionOcrModel ||
          PROVIDER_CATALOG.gemini.defaultVisionModel!;
        const res = await (deps?.runGeminiVision || analyzeComicPage)(
          page,
          readingDirection,
          { ...normalized, visionOcrModel: modelUsed },
          options
        );
        return { ...res, providerUsed: 'gemini', modelUsed };
      }

      if (prov === 'qwen_studio' && deps?.runQwenVision) {
        const res = await deps.runQwenVision(page, readingDirection, normalized, options);
        return {
          ...res,
          providerUsed: 'qwen_studio',
          modelUsed:
            normalized.providers?.qwen_studio?.visionModel ||
            PROVIDER_CATALOG.qwen_studio.defaultVisionModel!,
        };
      }

      const res = await (deps?.runOpenAiVision || analyzeComicPageWithOpenAiVision)(
        prov,
        page,
        readingDirection,
        normalized,
        options
      );
      return {
        panels: res.panels,
        regions: res.regions,
        providerUsed: prov,
        modelUsed: res.modelUsed,
      };
    } catch (err) {
      lastErr = err;
      if (!normalized.autoFallback) throw err;
    }
  }

  throw lastErr;
}

export function buildProviderExecutionOrder(
  settings: AiSettings,
  statusMap: ProvidersStatusMap = getProvidersStatus()
): AiProviderId[] {
  const normalized = normalizeAiSettings(settings);
  const primary = normalizeAiProviderId(normalized.provider);
  if (!normalized.autoFallback) return [primary];

  const order: AiProviderId[] = [primary];
  for (const cand of normalized.fallbackOrder || ALL_PROVIDER_IDS) {
    if (cand === primary || order.includes(cand) || !statusMap[cand]) continue;

    const candModel =
      normalized.providers?.[cand]?.translationModel ||
      PROVIDER_CATALOG[cand].defaultTranslationModel;

    // Enforce user consent before auto-switching to any paid model
    if (!normalized.allowPaidFallback && isModelPaid(cand, candModel)) {
      continue;
    }

    order.push(cand);
  }
  return order;
}

export async function translateRegionsWithProvider(
  regions: TextRegion[],
  project: Project,
  storyMemory: StoryMemory,
  glossary: GlossaryEntry[],
  style: TranslationStyle,
  targetLanguage: string,
  settings: AiSettings,
  previousPageContext?: string,
  deps?: {
    runGemini?: typeof translateRegionsWithContext;
    runOpenAi?: typeof callOpenAiCompatibleChat;
    statusMap?: ProvidersStatusMap;
  }
): Promise<{
  translations: Array<{ id: string; translatedText: string; alternatives: string[]; speaker?: string }>;
  summaryAddition?: string;
  memoryUpdate?: import('./geminiService.ts').StoryMemoryDelta;
  providerUsed: AiProviderId;
  modelUsed: string;
  fallbackUsed: boolean;
}> {
  if (!regions.length) {
    return {
      translations: [],
      providerUsed: normalizeAiProviderId(settings.provider),
      modelUsed: settings.translationModel,
      fallbackUsed: false,
    };
  }

  const normalized = normalizeAiSettings(settings);
  const order = buildProviderExecutionOrder(normalized, deps?.statusMap);
  const primary = order[0];
  let lastErr: unknown;

  for (const prov of order) {
    try {
      if (prov === 'gemini') {
        const modelUsed =
          normalized.providers?.gemini?.translationModel || normalized.translationModel;
        const result = await (deps?.runGemini || translateRegionsWithContext)(
          regions,
          project,
          storyMemory,
          glossary,
          style,
          targetLanguage,
          { ...normalized, translationModel: modelUsed },
          previousPageContext
        );
        return {
          ...result,
          providerUsed: 'gemini',
          modelUsed,
          fallbackUsed: prov !== primary,
        };
      }

      const combinedText = regions.map((r) => r.originalText).join('\n');
      const systemInstruction = `${buildComicTranslationInstruction({
        project,
        storyMemory,
        glossary,
        style,
        targetLanguage,
        regionsText: combinedText,
        previousPageContext,
      })}

Return ONLY valid JSON with this exact schema:
{
  "translations": [
    {"id": "region-id", "translatedText": "string", "alternatives": ["alt1", "alt2"], "speaker": "optional string"}
  ],
  "summaryAddition": "short 1-sentence scene summary",
  "memoryUpdate": {
    "characters": [{"name": "string", "translatedName": "string", "speechStyle": "string", "relations": "string"}],
    "locations": ["string"],
    "loreTerms": ["string"],
    "relationships": ["string"],
    "keyFacts": ["string"],
    "translationDecisions": [{"original": "string", "translated": "string"}]
  }
}`;

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

      const model =
        normalized.providers?.[prov]?.translationModel ||
        PROVIDER_DEFAULT_MODELS[prov].translationModel;
      const endpointUrl = resolveProviderEndpoint(prov, normalized);

      const res = await (deps?.runOpenAi || callOpenAiCompatibleChat)({
        provider: prov,
        model,
        endpointUrl,
        systemPrompt: systemInstruction,
        userContent: `Translate the following ordered comic regions into ${targetLanguage}:\n${JSON.stringify(payload, null, 2)}`,
        expectJson: true,
        temperature: normalized.creativity,
      });

      const parsed = JSON.parse(extractJsonFromModelText(res.text || '{"translations":[]}')) as {
        translations?: Array<{
          id: string;
          translatedText: string;
          alternatives?: string[];
          speaker?: string;
        }>;
        summaryAddition?: string;
        memoryUpdate?: import('./geminiService.ts').StoryMemoryDelta;
      };

      return {
        translations: (parsed.translations || []).map((item) => ({
          id: item.id,
          translatedText: item.translatedText || '',
          alternatives: Array.isArray(item.alternatives) ? item.alternatives : [],
          speaker: item.speaker,
        })),
        summaryAddition: parsed.summaryAddition,
        memoryUpdate: parsed.memoryUpdate,
        providerUsed: prov,
        modelUsed: res.model,
        fallbackUsed: prov !== primary,
      };
    } catch (err) {
      lastErr = err;
      if (!normalized.autoFallback) throw err;
    }
  }

  throw lastErr;
}

export async function retranslateSingleBubbleWithProvider(
  targetRegion: TextRegion,
  siblingRegions: TextRegion[],
  project: Project,
  glossary: GlossaryEntry[],
  style: TranslationStyle,
  targetLanguage: string,
  settings: AiSettings,
  customInstruction?: string,
  deps?: {
    runGemini?: typeof retranslateSingleBubble;
    runOpenAi?: typeof callOpenAiCompatibleChat;
    statusMap?: ProvidersStatusMap;
  }
): Promise<{
  translatedText: string;
  alternatives: string[];
  providerUsed: AiProviderId;
  modelUsed: string;
  fallbackUsed: boolean;
}> {
  const normalized = normalizeAiSettings(settings);
  const order = buildProviderExecutionOrder(normalized, deps?.statusMap);
  const primary = order[0];
  let lastErr: unknown;

  for (const prov of order) {
    try {
      if (prov === 'gemini') {
        const modelUsed =
          normalized.providers?.gemini?.translationModel || normalized.translationModel;
        const result = await (deps?.runGemini || retranslateSingleBubble)(
          targetRegion,
          siblingRegions,
          project,
          glossary,
          style,
          targetLanguage,
          { ...normalized, translationModel: modelUsed },
          customInstruction
        );
        return {
          ...result,
          providerUsed: 'gemini',
          modelUsed,
          fallbackUsed: prov !== primary,
        };
      }

      const contextLines = siblingRegions
        .map(
          (r) =>
            `[#${r.readingOrder} ${r.id === targetRegion.id ? 'TARGET' : r.regionType}${r.speaker ? ` (${r.speaker})` : ''}] ${r.originalText} => ${r.translatedText || '(untranslated)'}`
        )
        .join('\n');

      const systemInstruction = `${buildComicTranslationInstruction({
        project,
        storyMemory: project.storyMemory,
        glossary,
        style,
        targetLanguage,
        regionsText: targetRegion.originalText,
      })}

Return ONLY valid JSON:
{"translatedText": "string", "alternatives": ["alt1", "alt2", "alt3"]}`;

      const model =
        normalized.providers?.[prov]?.translationModel ||
        PROVIDER_DEFAULT_MODELS[prov].translationModel;
      const endpointUrl = resolveProviderEndpoint(prov, normalized);

      const res = await (deps?.runOpenAi || callOpenAiCompatibleChat)({
        provider: prov,
        model,
        endpointUrl,
        systemPrompt: systemInstruction,
        userContent: `Page Context:\n${contextLines}\n\nTarget Bubble Geometry: width=${Math.round(targetRegion.boundingBox.width)}/1000, height=${Math.round(targetRegion.boundingBox.height)}/1000\n${customInstruction ? `User instruction: ${customInstruction}\n` : ''}Retranslate ONLY the TARGET bubble ("${targetRegion.originalText}") into ${targetLanguage} and provide 3 natural alternatives.`,
        expectJson: true,
        temperature: normalized.creativity,
      });

      const parsed = JSON.parse(
        extractJsonFromModelText(res.text || '{"translatedText":"","alternatives":[]}')
      ) as { translatedText?: string; alternatives?: string[] };

      return {
        translatedText: parsed.translatedText || '',
        alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : [],
        providerUsed: prov,
        modelUsed: res.model,
        fallbackUsed: prov !== primary,
      };
    } catch (err) {
      lastErr = err;
      if (!normalized.autoFallback) throw err;
    }
  }

  throw lastErr;
}
