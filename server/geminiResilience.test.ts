import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelFallbackChain,
  buildThinkingConfigForModel,
  executeWithGeminiResilience,
  GeminiUpstreamError,
  normalizeGeminiModel,
  parseGeminiUpstreamError,
} from './geminiResilience.ts';
import { ThinkingLevel } from '@google/genai';

test('parseGeminiUpstreamError extracts 503 UNAVAILABLE from raw @google/genai JSON error', () => {
  const err = new Error(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
  );
  const parsed = parseGeminiUpstreamError(err);
  assert.equal(parsed.httpStatus, 503);
  assert.equal(parsed.code, 'UNAVAILABLE');
  assert.equal(parsed.retryable, true);
  assert.match(parsed.rawMessage, /high demand/i);
});

test('normalizeGeminiModel and fallback chains never use deprecated models', () => {
  assert.equal(normalizeGeminiModel('gemini-1.5-flash'), 'gemini-4-hydrogen');
  assert.deepEqual(buildModelFallbackChain('gemini-4-hydrogen'), [
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
  ]);
  assert.deepEqual(buildModelFallbackChain('gemini-4-argon'), [
    'gemini-4-argon',
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
  ]);
  assert.equal(buildThinkingConfigForModel('gemini-4-hydrogen').thinkingLevel, ThinkingLevel.LOW);
  assert.equal(
    buildThinkingConfigForModel('gemini-3.1-flash-lite').thinkingLevel,
    ThinkingLevel.MINIMAL
  );
});

test('executeWithGeminiResilience retries transient 503 on primary model and succeeds', async () => {
  let calls = 0;
  const delays: number[] = [];

  const res = await executeWithGeminiResilience({
    primaryModel: 'gemini-4-hydrogen',
    operationName: 'test',
    baseDelayMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5, // jitter = 1.0
    run: async (model) => {
      calls++;
      assert.equal(model, 'gemini-4-hydrogen');
      if (calls < 3) {
        throw new Error(
          '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'
        );
      }
      return 'OK';
    },
  });

  assert.equal(res.result, 'OK');
  assert.equal(res.modelUsed, 'gemini-4-hydrogen');
  assert.equal(res.fallbackUsed, false);
  assert.equal(res.attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('executeWithGeminiResilience falls back to gemini-3.1-flash-lite when primary stays 503', async () => {
  const modelsTried: string[] = [];

  const res = await executeWithGeminiResilience({
    primaryModel: 'gemini-4-hydrogen',
    operationName: 'translate',
    maxRetriesPrimary: 1,
    maxRetriesFallback: 1,
    baseDelayMs: 10,
    sleep: async () => {},
    run: async (model) => {
      modelsTried.push(model);
      if (model === 'gemini-4-hydrogen') {
        throw new Error(
          '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'
        );
      }
      return { translated: true };
    },
  });

  assert.deepEqual(modelsTried, ['gemini-4-hydrogen', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite']);
  assert.equal(res.modelUsed, 'gemini-3.1-flash-lite');
  assert.equal(res.fallbackUsed, true);
  assert.deepEqual(res.result, { translated: true });
});

test('executeWithGeminiResilience throws clean GeminiUpstreamError with 503 status when all models fail', async () => {
  await assert.rejects(
    () =>
      executeWithGeminiResilience({
        primaryModel: 'gemini-4-hydrogen',
        operationName: 'analyze',
        maxRetriesPrimary: 1,
        maxRetriesFallback: 0,
        sleep: async () => {},
        run: async () => {
          throw new Error(
            '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'
          );
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof GeminiUpstreamError);
      assert.equal(err.httpStatus, 503);
      assert.equal(err.code, 'UNAVAILABLE');
      assert.equal(err.retryable, true);
      assert.deepEqual(err.attemptedModels, ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']);
      assert.ok(!err.message.startsWith('{'), 'User-facing error should not be raw JSON');
      return true;
    }
  );
});

test('executeWithGeminiResilience does not retry non-retryable 400 INVALID_ARGUMENT', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeWithGeminiResilience({
        primaryModel: 'gemini-4-hydrogen',
        operationName: 'analyze',
        sleep: async () => {},
        run: async () => {
          calls++;
          throw new Error('{"error":{"code":400,"message":"Bad image bytes","status":"INVALID_ARGUMENT"}}');
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof GeminiUpstreamError);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    }
  );
  assert.equal(calls, 1);
});
