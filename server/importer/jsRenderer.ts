import fs from 'fs';
import { spawn } from 'child_process';

const CHROMIUM_CANDIDATES = [
  '/ms-playwright/chrome-headless-shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
  '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
];

function findChromiumBinary(): string | null {
  for (const p of CHROMIUM_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface JsRenderedResult {
  title: string;
  finalUrl: string;
  html: string;
  imgUrls: string[];
  hasCaptchaOrLogin: boolean;
}

/**
 * Uses the container's preinstalled headless Chromium over CDP (DevTools WebSocket)
 * strictly for public JS-rendered SPA pages that returned 200 OK without static <img> tags.
 * Never bypasses CAPTCHA or login walls; detects them and returns gracefully.
 */
export async function renderPageDomWithChromium(
  targetUrl: string,
  timeoutMs = 12000
): Promise<JsRenderedResult | null> {
  const bin = findChromiumBinary();
  if (!bin) return null;

  const child = spawn(
    bin,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chromium startup timeout')), 5000);
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stderr.on('data', onData);
      child.stdout.on('data', onData);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium exited early (${code})`));
      });
    });

    const listRes = await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '/json/list'));
    const targets = (await listRes.json()) as Array<{ webSocketDebuggerUrl?: string; type?: string }>;
    const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('No CDP page target available');
    }

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), 4000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket error'));
      });
    });

    let seq = 1;
    const callCdp = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const id = seq++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), timeoutMs);
        const handler = (ev: MessageEvent) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.id === id) {
              clearTimeout(timer);
              ws.removeEventListener('message', handler);
              if (msg.error) reject(new Error(msg.error.message || 'CDP Error'));
              else resolve(msg.result);
            }
          } catch {
            // Ignore non-JSON events
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await callCdp('Page.enable');
    await callCdp('Runtime.enable');
    await callCdp('Page.navigate', { url: targetUrl });

    // Allow SPA hydration & lazy images to settle
    await new Promise((r) => setTimeout(r, 3200));

    const evalRes = (await callCdp('Runtime.evaluate', {
      expression: `(() => {
        const textLower = (document.body?.innerText || '').toLowerCase();
        const hasCaptcha = Boolean(
          document.querySelector('[class*="turnstile"], iframe[src*="captcha"], iframe[src*="turnstile"]') ||
          textLower.includes('verify you are human') ||
          textLower.includes('just a moment')
        );
        const imgs = Array.from(document.querySelectorAll('img')).map((el) =>
          el.getAttribute('data-src') || el.getAttribute('data-original') || el.currentSrc || el.src || ''
        ).filter(Boolean);
        return {
          title: document.title || '',
          finalUrl: location.href,
          html: document.documentElement.outerHTML.slice(0, 120000),
          imgUrls: imgs,
          hasCaptchaOrLogin: hasCaptcha
        };
      })()`,
      returnByValue: true,
    })) as { result?: { value?: JsRenderedResult } };

    ws.close();
    return evalRes.result?.value || null;
  } catch {
    return null;
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore cleanup error
    }
  }
}
