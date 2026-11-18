import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AiProviderId } from '../src/types/domain.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const VAULT_KEY_FILE = path.resolve(DATA_DIR, '.vault.key');
const SECRETS_FILE = path.resolve(DATA_DIR, '.secrets.enc.json');

export interface StoredProviderSecret {
  apiKey: string;
  accountId?: string;
  updatedAt: string;
}

type VaultMap = Partial<Record<AiProviderId, StoredProviderSecret>>;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getOrCreateVaultMasterKey(): Buffer {
  ensureDataDir();
  if (fs.existsSync(VAULT_KEY_FILE)) {
    const hex = fs.readFileSync(VAULT_KEY_FILE, 'utf-8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) return buf;
  }
  const masterKey = crypto.randomBytes(32);
  fs.writeFileSync(VAULT_KEY_FILE, masterKey.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  return masterKey;
}

function encryptPayload(plaintext: string): { iv: string; tag: string; ciphertext: string } {
  const key = getOrCreateVaultMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptPayload(blob: { iv: string; tag: string; ciphertext: string }): string {
  const key = getOrCreateVaultMasterKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

function readVault(): VaultMap {
  ensureDataDir();
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8')) as {
      iv: string;
      tag: string;
      ciphertext: string;
    };
    const json = decryptPayload(raw);
    return JSON.parse(json) as VaultMap;
  } catch {
    return {};
  }
}

function writeVault(map: VaultMap): void {
  ensureDataDir();
  const encrypted = encryptPayload(JSON.stringify(map));
  const tmp = `${SECRETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(encrypted, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
}

export function getVaultSecret(provider: AiProviderId): StoredProviderSecret | undefined {
  const vault = readVault();
  const entry = vault[provider];
  if (!entry || !entry.apiKey?.trim()) return undefined;
  return entry;
}

export function setVaultSecret(
  provider: AiProviderId,
  apiKey: string,
  accountId?: string
): StoredProviderSecret {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('API key cannot be empty.');
  }
  const vault = readVault();
  const record: StoredProviderSecret = {
    apiKey: cleanKey,
    accountId: accountId?.trim() || vault[provider]?.accountId,
    updatedAt: new Date().toISOString(),
  };
  vault[provider] = record;
  writeVault(vault);
  return record;
}

export function deleteVaultSecret(provider: AiProviderId): void {
  const vault = readVault();
  if (vault[provider]) {
    delete vault[provider];
    writeVault(vault);
  }
}

export function maskApiKey(rawKey?: string): string | undefined {
  const clean = rawKey?.trim();
  if (!clean) return undefined;
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

export function collectKnownSecretStrings(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = new Set<string>();
  const envKeys = [
    env.GEMINI_API_KEY,
    env.GROQ_API_KEY,
    env.OPENROUTER_API_KEY,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_KEY,
    env.DEEPSEEK_API_KEY,
    env.QWEN_API_KEY,
    env.DASHSCOPE_API_KEY,
  ];
  for (const val of envKeys) {
    if (val && val.trim().length >= 8 && !val.startsWith('MY_')) {
      secrets.add(val.trim());
    }
  }
  const vault = readVault();
  for (const entry of Object.values(vault)) {
    if (entry?.apiKey && entry.apiKey.trim().length >= 8) {
      secrets.add(entry.apiKey.trim());
    }
  }
  return Array.from(secrets);
}

/**
 * Redacts API keys, Bearer tokens, and query ?key= values from strings before logging or returning errors.
 */
export function redactSecrets(input: string, extraSecrets: string[] = []): string {
  if (!input) return '';
  let out = input;

  const allSecrets = new Set<string>([
    ...collectKnownSecretStrings(),
    ...extraSecrets.filter((s) => s && s.trim().length >= 8),
  ]);

  for (const sec of allSecrets) {
    if (out.includes(sec)) {
      out = out.split(sec).join('[REDACTED_KEY]');
    }
  }

  out = out
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED_KEY]')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED_KEY]')
    .replace(/\b(AIza[0-9A-Za-z_-]{16,})\b/g, '[REDACTED_KEY]')
    .replace(/\b(gsk_[0-9A-Za-z_-]{16,})\b/g, '[REDACTED_KEY]')
    .replace(/\b(sk-or-v1-[0-9A-Za-z_-]{16,})\b/g, '[REDACTED_KEY]')
    .replace(/\b(sk-[0-9A-Za-z_-]{16,})\b/g, '[REDACTED_KEY]');

  return out;
}
