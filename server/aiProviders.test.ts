import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { AiSettings, GlossaryEntry, Project, TextRegion } from '../src/types/domain.ts';
import {
  buildOpenAiChatPayload,
  buildProviderExecutionOrder,
  buildVisionExecutionOrder,
  DEFAULT_AI_SETTINGS,
  extractJsonFromModelText,
  generateTestVisionPngBase64,
  getProvidersDetailedStatus,
  getProvidersStatus,
  normalizeAiSettings,
  retranslateSingleBubbleWithProvider,
  testProviderConnection,
  translateRegionsWithProvider,
  validateEndpointUrl,
} from './aiProviders.ts';
import {
  ALL_PROVIDER_IDS,
  parseDynamicModelsResponse,
  PROVIDER_CATALOG,
  resolveCloudflareEndpoint,
} from './providerCatalog.ts';
import {
  deleteVaultSecret,
  getVaultSecret,
  redactSecrets,
  setVaultSecret,
} from './secretVault.ts';
import { GeminiUpstreamError } from './geminiResilience.ts';

const MOCK_PROJECT: Project = {
  id: 'proj-test',
  userId: 'user-1',
  title: 'Apex Vanguard',
  comicFormat: 'superhero',
  sourceLanguage: 'en',
  targetLanguage: 'ar',
  readingDirection: 'ltr',
  translationStyle: 'cinematic',
  storyMemory: {
    characters: [],
    locations: [],
    recurringNotes: '',
    chapterSummaries: [],
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const MOCK_REGIONS: TextRegion[] = [
  {
    id: 'reg-1',
    pageId: 'page-1',
    regionType: 'dialogue',
    boundingBox: { x: 100, y: 100, width: 220, height: 120 },
    boundingPolygon: [
      { x: 100, y: 100 },
      { x: 320, y: 100 },
      { x: 320, y: 220 },
      { x: 100, y: 220 },
    ],
    originalText: 'HOLD THE LINE!',
    translatedText: '',
    alternatives: [],
    sourceLanguage: 'en',
    confidence: 0.98,
    readingOrder: 1,
    fontSettings: {
      fontFamily: 'Cairo',
      fontSize: 22,
      fontWeight: '700',
      color: '#111111',
      align: 'center',
      lineHeight: 1.2,
      padding: 8,
      rotation: 0,
      direction: 'rtl',
      autoFit: true,
      offsetX: 0,
      offsetY: 0,
    },
    cleanMode: 'auto',
    sfxMode: 'keep',
    approvalStatus: 'pending',
    translationStatus: 'untranslated',
  },
];

const MOCK_GLOSSARY: GlossaryEntry[] = [];

test('PROVIDER_CATALOG defines all 6 providers with official key & docs URLs', () => {
  assert.deepEqual(ALL_PROVIDER_IDS, [
    'gemini',
    'groq',
    'openrouter',
    'cloudflare',
    'deepseek',
    'qwen_studio',
  ]);
  assert.equal(PROVIDER_CATALOG.gemini.apiKeyUrl, 'https://aistudio.google.com/apikey');
  assert.equal(PROVIDER_CATALOG.groq.apiKeyUrl, 'https://console.groq.com/keys');
  assert.equal(PROVIDER_CATALOG.openrouter.apiKeyUrl, 'https://openrouter.ai/settings/keys');
  assert.equal(PROVIDER_CATALOG.cloudflare.apiKeyUrl, 'https://dash.cloudflare.com/');
  assert.equal(PROVIDER_CATALOG.deepseek.apiKeyUrl, 'https://platform.deepseek.com/api_keys');
  assert.equal(PROVIDER_CATALOG.qwen_studio.apiKeyUrl, 'https://bailian.console.aliyun.com/');
  assert.equal(PROVIDER_CATALOG.deepseek.supportsVision, false);
});

test('getProvidersStatus and getProvidersDetailedStatus detect all 6 secrets safely without leaking raw keys', () => {
  const env = {
    GEMINI_API_KEY: 'AIzaSyFakeTestKey0000000000000',
    GROQ_API_KEY: 'gsk_FakeGroqKey1234567890abcd',
    OPENROUTER_API_KEY: 'sk-or-v1-FakeOpenRouterKey98765',
    CLOUDFLARE_API_TOKEN: 'cf-fake-token-1234567890',
    CLOUDFLARE_ACCOUNT_ID: 'acct-9876543210',
    DEEPSEEK_API_KEY: 'sk-ds-test-12345678',
    QWEN_API_KEY: '',
    DASHSCOPE_API_KEY: 'sk-qwen-test-99999999',
  } as NodeJS.ProcessEnv;

  const status = getProvidersStatus(env);
  for (const id of ALL_PROVIDER_IDS) {
    assert.equal(status[id], true, `Expected ${id} to be detected`);
  }

  const detailed = getProvidersDetailedStatus(DEFAULT_AI_SETTINGS, env);
  assert.equal(detailed.groq.configured, true);
  assert.ok(detailed.groq.maskedHint?.includes('••••'));
  assert.ok(!JSON.stringify(detailed).includes('gsk_FakeGroqKey1234567890abcd'));
  assert.equal(detailed.cloudflare.hasAccountId, true);

  const emptyStatus = getProvidersStatus({} as NodeJS.ProcessEnv);
  assert.equal(emptyStatus.groq, false);
  assert.equal(emptyStatus.openrouter, false);
  assert.equal(emptyStatus.cloudflare, false);
  assert.equal(emptyStatus.deepseek, false);
  assert.equal(emptyStatus.qwen_studio, false);
});

test('resolveCloudflareEndpoint injects Account ID cleanly and preserves custom URLs', () => {
  assert.equal(
    resolveCloudflareEndpoint('9f8a7b6c5d4e'),
    'https://api.cloudflare.com/client/v4/accounts/9f8a7b6c5d4e/ai/v1'
  );
  assert.equal(
    resolveCloudflareEndpoint(
      'newacct123',
      'https://api.cloudflare.com/client/v4/accounts/oldacct/ai/v1'
    ),
    'https://api.cloudflare.com/client/v4/accounts/newacct123/ai/v1'
  );
  assert.equal(
    resolveCloudflareEndpoint('', 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1'),
    'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1'
  );
});

test('parseDynamicModelsResponse classifies vision vs text, free vs paid, and filters deprecated Gemini models', () => {
  const openRouterParsed = parseDynamicModelsResponse('openrouter', {
    data: [
      {
        id: 'google/gemma-3-27b-it:free',
        name: 'Gemma 3 27B Free',
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
        pricing: { prompt: '0', completion: '0' },
      },
      {
        id: 'anthropic/claude-opus-4',
        name: 'Claude Opus 4',
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
        pricing: { prompt: '0.000015', completion: '0.000075' },
      },
      {
        id: 'google/gemini-2.0-flash-exp:free',
        name: 'Deprecated 2.0',
        pricing: { prompt: '0', completion: '0' },
      },
    ],
  });
  const gemma = openRouterParsed.find((m) => m.id === 'google/gemma-3-27b-it:free');
  const opus = openRouterParsed.find((m) => m.id === 'anthropic/claude-opus-4');
  assert.equal(gemma?.supportsVision, true);
  assert.equal(gemma?.isFree, true);
  assert.equal(opus?.supportsVision, true);
  assert.equal(opus?.isFree, false);
  assert.equal(
    openRouterParsed.some((m) => m.id.includes('gemini-2.0')),
    false
  );

  const geminiParsed = parseDynamicModelsResponse('gemini', {
    models: [
      { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
    ],
  });
  assert.equal(geminiParsed.some((m) => m.id.includes('1.5') || m.id.includes('2.0')), false);
  assert.equal(geminiParsed.some((m) => m.id === 'gemini-3.1-flash-lite'), true);

  const cfParsed = parseDynamicModelsResponse('cloudflare', {
    result: [
      { name: '@cf/meta/llama-3.2-11b-vision-instruct', task: { name: 'Image-to-Text' } },
      { name: '@cf/baai/bge-large-en-v1.5', task: { name: 'Text Embeddings' } },
    ],
  });
  assert.equal(cfParsed.some((m) => m.id === '@cf/baai/bge-large-en-v1.5'), false);
  assert.equal(
    cfParsed.find((m) => m.id === '@cf/meta/llama-3.2-11b-vision-instruct')?.supportsVision,
    true
  );
});

test('extractJsonFromModelText strips DeepSeek <think> blocks and markdown fences', () => {
  const raw = `<think>Translating comic bubble...</think>
\`\`\`json
{
  "translations": [{"id": "reg-1", "translatedText": "اثبتوا في مواقعكم!", "alternatives": ["تمسكوا بالخط!"]}]
}
\`\`\``;
  const extracted = extractJsonFromModelText(raw);
  const parsed = JSON.parse(extracted);
  assert.equal(parsed.translations[0].translatedText, 'اثبتوا في مواقعكم!');
});

test('buildOpenAiChatPayload configures DeepSeek Reasoner and Qwen Studio appropriately', () => {
  const dsChat = buildOpenAiChatPayload({
    provider: 'deepseek',
    model: 'deepseek-chat',
    systemPrompt: 'sys',
    userContent: 'hello',
    expectJson: true,
    temperature: 0.4,
  });
  assert.deepEqual(dsChat.response_format, { type: 'json_object' });
  assert.equal(dsChat.temperature, 0.4);

  const dsReasoner = buildOpenAiChatPayload({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    systemPrompt: 'sys',
    userContent: 'hello',
    expectJson: true,
    temperature: 0.4,
  });
  assert.equal(dsReasoner.response_format, undefined);
  assert.equal(dsReasoner.temperature, undefined);

  const qwenVl = buildOpenAiChatPayload({
    provider: 'qwen_studio',
    model: 'qwen-vl-max',
    userContent: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      { type: 'text', text: 'OCR' },
    ],
    expectJson: true,
  });
  assert.equal(qwenVl.response_format, undefined);
});

test('validateEndpointUrl rejects SSRF metadata endpoints, missing CF Account ID, and invalid protocols', () => {
  assert.throws(
    () => validateEndpointUrl('http://169.254.169.254/latest/meta-data'),
    GeminiUpstreamError
  );
  assert.throws(() => validateEndpointUrl('ftp://api.deepseek.com/v1'), GeminiUpstreamError);
  assert.throws(
    () =>
      validateEndpointUrl(
        'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1'
      ),
    GeminiUpstreamError
  );
  assert.equal(
    validateEndpointUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'),
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  );
});

test('normalizeAiSettings upgrades legacy settings cleanly with all 6 provider defaults', () => {
  const normalized = normalizeAiSettings({
    provider: 'gemini',
    translationModel: 'gemini-3.1-flash-lite',
  });
  assert.equal(normalized.provider, 'gemini');
  assert.equal(normalized.visionProvider, 'gemini');
  assert.equal(normalized.autoFallback, true);
  assert.equal(normalized.allowPaidFallback, false);
  assert.equal(normalized.providers?.groq.translationModel, 'llama-3.3-70b-versatile');
  assert.equal(
    normalized.providers?.openrouter.translationModel,
    'deepseek/deepseek-chat-v3-0324:free'
  );
  assert.equal(
    normalized.providers?.cloudflare.translationModel,
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  );
  assert.equal(normalized.providers?.deepseek.translationModel, 'deepseek-chat');
  assert.equal(normalized.providers?.qwen_studio.translationModel, 'qwen-plus');
  assert.equal(normalized.providers?.qwen_studio.visionModel, 'qwen-vl-max');
});

test('buildProviderExecutionOrder blocks automatic fallback to paid models without explicit user consent', () => {
  const status = {
    gemini: true,
    groq: true,
    openrouter: true,
    cloudflare: false,
    deepseek: true,
    qwen_studio: true,
  };

  const freeOnlySettings: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    provider: 'groq',
    autoFallback: true,
    allowPaidFallback: false,
    fallbackOrder: ['groq', 'openrouter', 'deepseek', 'qwen_studio', 'gemini'],
  };
  const freeOrder = buildProviderExecutionOrder(freeOnlySettings, status);
  assert.deepEqual(freeOrder, ['groq', 'openrouter', 'gemini']);

  const withPaidConsentSettings: AiSettings = {
    ...freeOnlySettings,
    allowPaidFallback: true,
  };
  const paidOrder = buildProviderExecutionOrder(withPaidConsentSettings, status);
  assert.deepEqual(paidOrder, ['groq', 'openrouter', 'deepseek', 'qwen_studio', 'gemini']);
});

test('buildVisionExecutionOrder never routes OCR to text-only DeepSeek or text-only models', () => {
  const status = {
    gemini: true,
    groq: true,
    openrouter: true,
    cloudflare: true,
    deepseek: true,
    qwen_studio: true,
  };
  const settings: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    visionProvider: 'groq',
    autoFallback: true,
    allowPaidFallback: false,
    fallbackOrder: ['deepseek', 'groq', 'openrouter', 'cloudflare', 'qwen_studio', 'gemini'],
  };
  const visionOrder = buildVisionExecutionOrder(settings, status);
  assert.equal(visionOrder.includes('deepseek'), false);
  assert.deepEqual(visionOrder, ['groq', 'openrouter', 'cloudflare', 'gemini']);
});

test('generateTestVisionPngBase64 builds a valid PNG buffer and testProviderConnection verifies translation + vision', async () => {
  const b64 = generateTestVisionPngBase64();
  const buf = Buffer.from(b64, 'base64');
  assert.deepEqual(Array.from(buf.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

  let callCount = 0;
  const mockFetch = (async (_url: string, init?: RequestInit) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body || '{}'));
    if (callCount === 1) {
      assert.ok(JSON.stringify(body.messages).includes('Hold the line!'));
      return new Response(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { content: 'اثبت في مكانك!' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Second call must contain real PNG image_url
    assert.ok(JSON.stringify(body.messages).includes('data:image/png;base64,'));
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { content: 'PNG image HI confirmed.' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const res = await testProviderConnection({
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    apiKey: 'gsk_test_mock_key_99999999',
    testVision: true,
    fetchImpl: mockFetch,
  });

  assert.equal(res.ok, true);
  assert.equal(res.provider, 'groq');
  assert.equal(res.translationVerified, true);
  assert.equal(res.visionVerified, true);
  assert.equal(res.message, 'اثبت في مكانك!');
  assert.equal(callCount, 2);
});

test('redactSecrets strips API keys, Bearer tokens, and ?key= query strings', () => {
  const sanitized = redactSecrets(
    'Failed GET https://generativelanguage.googleapis.com/v1/models?key=AIzaSySecretValue1234567890 with Bearer gsk_SecretGroqToken123456 and sk-or-v1-abc1234567890xyz99',
    ['my-custom-secret-token']
  );
  assert.equal(sanitized.includes('AIzaSySecretValue1234567890'), false);
  assert.equal(sanitized.includes('gsk_SecretGroqToken123456'), false);
  assert.equal(sanitized.includes('sk-or-v1-abc1234567890xyz99'), false);
  assert.ok(sanitized.includes('[REDACTED_KEY]'));
});

test('secretVault encrypts keys on disk with AES-256-GCM and cleanly deletes them', () => {
  const testSecret = 'gsk_TestVaultEncryptionSecret98765';
  const prev = getVaultSecret('groq');
  try {
    setVaultSecret('groq', testSecret);
    const loaded = getVaultSecret('groq');
    assert.equal(loaded?.apiKey, testSecret);

    const encryptedFilePath = path.resolve(process.cwd(), 'data/.secrets.enc.json');
    const rawOnDisk = fs.readFileSync(encryptedFilePath, 'utf-8');
    assert.equal(rawOnDisk.includes(testSecret), false);
  } finally {
    if (prev) {
      setVaultSecret('groq', prev.apiKey, prev.accountId);
    } else {
      deleteVaultSecret('groq');
    }
  }
});

test('translateRegionsWithProvider routes to Groq and falls back to OpenRouter free on 503', async () => {
  const settings: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    provider: 'groq',
    autoFallback: true,
    allowPaidFallback: false,
    fallbackOrder: ['groq', 'openrouter', 'deepseek', 'qwen_studio', 'gemini'],
  };

  const calls: string[] = [];
  const res = await translateRegionsWithProvider(
    MOCK_REGIONS,
    MOCK_PROJECT,
    MOCK_PROJECT.storyMemory,
    MOCK_GLOSSARY,
    'cinematic',
    'ar',
    settings,
    undefined,
    {
      statusMap: {
        gemini: false,
        groq: true,
        openrouter: true,
        cloudflare: false,
        deepseek: true,
        qwen_studio: true,
      },
      runOpenAi: async ({ provider, model }) => {
        calls.push(`${provider}:${model}`);
        if (provider === 'groq') {
          throw new GeminiUpstreamError('Groq 503', {
            httpStatus: 503,
            code: 'UNAVAILABLE',
            retryable: true,
            upstreamStatus: 'HTTP_503',
            attemptedModels: [model],
          });
        }
        return {
          model,
          text: JSON.stringify({
            translations: [
              {
                id: 'reg-1',
                translatedText: 'اثبتوا في مواقعكم!',
                alternatives: ['لا تتراجعوا!'],
              },
            ],
            summaryAddition: 'البطل يأمر بالثبات.',
          }),
        };
      },
    }
  );

  assert.deepEqual(calls, [
    'groq:llama-3.3-70b-versatile',
    'openrouter:deepseek/deepseek-chat-v3-0324:free',
  ]);
  assert.equal(res.providerUsed, 'openrouter');
  assert.equal(res.fallbackUsed, true);
  assert.equal(res.translations[0].translatedText, 'اثبتوا في مواقعكم!');
});

test('retranslateSingleBubbleWithProvider uses Qwen Studio directly when selected', async () => {
  const settings: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    provider: 'qwen_studio',
    autoFallback: false,
  };

  const res = await retranslateSingleBubbleWithProvider(
    MOCK_REGIONS[0],
    MOCK_REGIONS,
    MOCK_PROJECT,
    MOCK_GLOSSARY,
    'cinematic',
    'ar',
    settings,
    'اجعلها أقصر',
    {
      statusMap: {
        gemini: true,
        groq: false,
        openrouter: false,
        cloudflare: false,
        deepseek: false,
        qwen_studio: true,
      },
      runOpenAi: async ({ provider, model }) => {
        assert.equal(provider, 'qwen_studio');
        return {
          model,
          text: '{"translatedText":"اثبتوا!","alternatives":["صمود!","تقدموا!"]}',
        };
      },
    }
  );

  assert.equal(res.providerUsed, 'qwen_studio');
  assert.equal(res.fallbackUsed, false);
  assert.equal(res.translatedText, 'اثبتوا!');
  assert.deepEqual(res.alternatives, ['صمود!', 'تقدموا!']);
});
