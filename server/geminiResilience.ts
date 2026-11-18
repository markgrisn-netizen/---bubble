import { ThinkingLevel } from '@google/genai';

export const SUPPORTED_GEMINI_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-4-argon',
] as const;

export type SupportedGeminiModel = (typeof SUPPORTED_GEMINI_MODELS)[number];

export type GeminiErrorCode =
  | 'UNAVAILABLE'
  | 'RESOURCE_EXHAUSTED'
  | 'PERMISSION_DENIED'
  | 'API_KEY_INVALID'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR';

export interface ParsedGeminiError {
  httpStatus: number;
  upstreamStatus: string;
  rawMessage: string;
  retryable: boolean;
  code: GeminiErrorCode;
}

export class GeminiUpstreamError extends Error {
  public readonly httpStatus: number;
  public readonly code: GeminiErrorCode;
  public readonly retryable: boolean;
  public readonly upstreamStatus: string;
  public readonly attemptedModels: string[];

  constructor(
    message: string,
    opts: {
      httpStatus: number;
      code: GeminiErrorCode;
      retryable: boolean;
      upstreamStatus: string;
      attemptedModels: string[];
    }
  ) {
    super(message);
    this.name = 'GeminiUpstreamError';
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.upstreamStatus = opts.upstreamStatus;
    this.attemptedModels = opts.attemptedModels;
  }
}

const DEPRECATED_GEMINI_MODELS =
  /gemini-1\.0|gemini-1\.5|gemini-2\.0|^gemini-pro$|^models\/gemini-pro$/i;

export function normalizeGeminiModel(requested?: string): string {
  const clean = (requested || '').trim().replace(/^models\//, '');
  if (!clean || DEPRECATED_GEMINI_MODELS.test(clean) || !clean.toLowerCase().startsWith('gemini-')) {
    return 'gemini-4-hydrogen';
  }
  return clean;
}

export function buildModelFallbackChain(primary: string): string[] {
  if (primary === 'gemini-4-hydrogen') {
    return ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  }
  if (primary === 'gemini-3.1-flash-lite') {
    return ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
  }
  if (primary === 'gemini-4-argon') {
    return ['gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  }
  return [primary, 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
}

export function buildThinkingConfigForModel(model: string): {
  thinkingLevel: ThinkingLevel;
} {
  if (model.includes('flash-lite')) {
    return { thinkingLevel: ThinkingLevel.MINIMAL };
  }
  return { thinkingLevel: ThinkingLevel.LOW };
}

export function parseGeminiUpstreamError(err: unknown): ParsedGeminiError {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  let rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err ?? 'Unknown AI error');

  let httpStatus =
    typeof errObj.status === 'number'
      ? errObj.status
      : typeof errObj.statusCode === 'number'
        ? errObj.statusCode
        : typeof errObj.code === 'number'
          ? errObj.code
          : 0;
  let upstreamStatus = '';

  // @google/genai often embeds {"error":{"code":503,"message":"...","status":"UNAVAILABLE"}} in err.message
  const jsonStart = rawMessage.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsedJson = JSON.parse(rawMessage.slice(jsonStart)) as {
        error?: { code?: number; message?: string; status?: string };
      };
      if (parsedJson?.error) {
        if (typeof parsedJson.error.code === 'number' && !httpStatus) {
          httpStatus = parsedJson.error.code;
        }
        if (typeof parsedJson.error.status === 'string') {
          upstreamStatus = parsedJson.error.status.toUpperCase();
        }
        if (typeof parsedJson.error.message === 'string' && parsedJson.error.message.trim()) {
          rawMessage = parsedJson.error.message.trim();
        }
      }
    } catch {
      // Non-JSON message; continue with regex heuristics
    }
  }

  const upper = `${upstreamStatus} ${rawMessage}`.toUpperCase();

  if (
    httpStatus === 503 ||
    upper.includes('UNAVAILABLE') ||
    upper.includes('HIGH DEMAND') ||
    upper.includes('OVERLOADED')
  ) {
    return {
      httpStatus: 503,
      upstreamStatus: upstreamStatus || 'UNAVAILABLE',
      rawMessage,
      retryable: true,
      code: 'UNAVAILABLE',
    };
  }

  if (
    httpStatus === 429 ||
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('QUOTA') ||
    upper.includes('RATE LIMIT')
  ) {
    return {
      httpStatus: 429,
      upstreamStatus: upstreamStatus || 'RESOURCE_EXHAUSTED',
      rawMessage,
      retryable: true,
      code: 'RESOURCE_EXHAUSTED',
    };
  }

  if (
    httpStatus === 500 ||
    httpStatus === 502 ||
    httpStatus === 504 ||
    upper.includes('DEADLINE_EXCEEDED') ||
    upper.includes('INTERNAL')
  ) {
    return {
      httpStatus: httpStatus || 503,
      upstreamStatus: upstreamStatus || 'INTERNAL',
      rawMessage,
      retryable: true,
      code: 'UPSTREAM_ERROR',
    };
  }

  if (
    upper.includes('FETCH FAILED') ||
    upper.includes('ECONNRESET') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('EAI_AGAIN') ||
    upper.includes('SOCKET HANG UP')
  ) {
    return {
      httpStatus: 503,
      upstreamStatus: 'NETWORK_ERROR',
      rawMessage,
      retryable: true,
      code: 'NETWORK_ERROR',
    };
  }

  if (httpStatus === 403 || upper.includes('PERMISSION_DENIED')) {
    return {
      httpStatus: 403,
      upstreamStatus: upstreamStatus || 'PERMISSION_DENIED',
      rawMessage,
      retryable: false,
      code: 'PERMISSION_DENIED',
    };
  }

  if (upper.includes('API_KEY_INVALID') || upper.includes('API KEY NOT VALID')) {
    return {
      httpStatus: 400,
      upstreamStatus: upstreamStatus || 'API_KEY_INVALID',
      rawMessage,
      retryable: false,
      code: 'API_KEY_INVALID',
    };
  }

  if (httpStatus === 404 || upper.includes('NOT_FOUND')) {
    return {
      httpStatus: 404,
      upstreamStatus: upstreamStatus || 'NOT_FOUND',
      rawMessage,
      retryable: false,
      code: 'NOT_FOUND',
    };
  }

  if (httpStatus === 400 || upper.includes('INVALID_ARGUMENT')) {
    return {
      httpStatus: 400,
      upstreamStatus: upstreamStatus || 'INVALID_ARGUMENT',
      rawMessage,
      retryable: false,
      code: 'INVALID_ARGUMENT',
    };
  }

  return {
    httpStatus: httpStatus >= 400 ? httpStatus : 502,
    upstreamStatus: upstreamStatus || 'UPSTREAM_ERROR',
    rawMessage,
    retryable: false,
    code: 'UPSTREAM_ERROR',
  };
}

export function formatGeminiUserMessage(
  parsed: ParsedGeminiError,
  attemptedModels: string[]
): string {
  const modelsNote = attemptedModels.length > 0 ? ` [${attemptedModels.join(' → ')}]` : '';
  if (parsed.code === 'UNAVAILABLE' || parsed.code === 'NETWORK_ERROR') {
    return `نموذج الذكاء الاصطناعي يواجه ضغطاً مؤقتاً (503). تمت إعادة المحاولة وتجربة النموذج البديل تلقائياً${modelsNote}، يرجى المحاولة مرة أخرى بعد لحظات. (Temporary high demand — please retry shortly.)`;
  }
  if (parsed.code === 'RESOURCE_EXHAUSTED') {
    return `تم بلوغ حد الطلبات المؤقت (429)${modelsNote}. يُرجى الانتظار قليلاً أو التحقق من مفتاح API في لوحة Settings > Secrets.`;
  }
  if (parsed.code === 'PERMISSION_DENIED' || parsed.code === 'API_KEY_INVALID') {
    return 'مفتاح Gemini API غير صالح أو يفتقر للصلاحية المطلوبة. يُرجى التحقق منه في لوحة Settings > Secrets.';
  }
  if (parsed.code === 'NOT_FOUND') {
    return `النموذج المحدد غير متوفر حالياً${modelsNote}.`;
  }
  return parsed.rawMessage;
}

export interface ResilienceOptions<T> {
  primaryModel?: string;
  operationName: string;
  run: (model: string) => Promise<T>;
  maxRetriesPrimary?: number;
  maxRetriesFallback?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ResilienceResult<T> {
  result: T;
  modelUsed: string;
  fallbackUsed: boolean;
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function executeWithGeminiResilience<T>(
  opts: ResilienceOptions<T>
): Promise<ResilienceResult<T>> {
  const primary = normalizeGeminiModel(opts.primaryModel);
  const chain = buildModelFallbackChain(primary);
  const maxRetriesPrimary = opts.maxRetriesPrimary ?? 2;
  const maxRetriesFallback = opts.maxRetriesFallback ?? 1;
  const baseDelayMs = opts.baseDelayMs ?? 650;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastParsed: ParsedGeminiError | null = null;
  const attemptedModels: string[] = [];
  let totalAttempts = 0;

  for (let mIdx = 0; mIdx < chain.length; mIdx++) {
    const model = chain[mIdx];
    attemptedModels.push(model);
    const maxAttemptsForModel = 1 + (mIdx === 0 ? maxRetriesPrimary : maxRetriesFallback);

    for (let attempt = 1; attempt <= maxAttemptsForModel; attempt++) {
      totalAttempts++;
      try {
        const result = await opts.run(model);
        return {
          result,
          modelUsed: model,
          fallbackUsed: mIdx > 0,
          attempts: totalAttempts,
        };
      } catch (err) {
        // Never swallow missing API key configuration errors
        if (err instanceof Error && err.message.includes('GEMINI_API_KEY is not configured')) {
          throw err;
        }

        const parsed = parseGeminiUpstreamError(err);
        lastParsed = parsed;

        // If a paid-only primary model hits 429 or 404, allow falling back to free-tier sibling
        const allowFallbackOnThisError =
          parsed.retryable ||
          (mIdx === 0 && (parsed.code === 'NOT_FOUND' || parsed.code === 'RESOURCE_EXHAUSTED'));

        if (!allowFallbackOnThisError) {
          throw new GeminiUpstreamError(formatGeminiUserMessage(parsed, attemptedModels), {
            httpStatus: parsed.httpStatus,
            code: parsed.code,
            retryable: false,
            upstreamStatus: parsed.upstreamStatus,
            attemptedModels,
          });
        }

        if (attempt < maxAttemptsForModel && parsed.retryable) {
          const jitter = 0.8 + random() * 0.4;
          const delayMs = Math.round(baseDelayMs * Math.pow(2, attempt - 1) * jitter);
          await sleep(delayMs);
        } else {
          // Move to next fallback model in chain
          break;
        }
      }
    }
  }

  const finalParsed = lastParsed ?? {
    httpStatus: 503,
    upstreamStatus: 'UNAVAILABLE',
    rawMessage: `${opts.operationName} failed due to temporary model unavailability.`,
    retryable: true,
    code: 'UNAVAILABLE' as const,
  };

  throw new GeminiUpstreamError(formatGeminiUserMessage(finalParsed, attemptedModels), {
    httpStatus: finalParsed.httpStatus,
    code: finalParsed.code,
    retryable: finalParsed.retryable,
    upstreamStatus: finalParsed.upstreamStatus,
    attemptedModels,
  });
}
