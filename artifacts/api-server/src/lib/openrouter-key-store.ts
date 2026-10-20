import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.openrouter-key.json');

function storePath(): string {
  return process.env.OPENROUTER_KEY_PATH?.trim() || DEFAULT_STORE;
}

let memoryKey: string | undefined | null = null; // null = not loaded, undefined = known empty
let memoryLoaded = false;

function loadFileKey(): string | undefined {
  try {
    const p = storePath();
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).key === 'string') {
        const v = (parsed as any).key.trim();
        return v || undefined;
      }
      if (typeof parsed === 'string') {
        const v = parsed.trim();
        return v || undefined;
      }
    } catch {
      if (raw.startsWith('sk-')) return raw;
      if (raw.length >= 10 && raw.length <= 512) return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function ensureLoaded(): void {
  if (memoryLoaded) return;
  memoryLoaded = true;
  if (memoryKey === null) {
    const fileKey = loadFileKey();
    memoryKey = fileKey ?? undefined;
  }
}

export function getStoredKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) return envKey;
  ensureLoaded();
  return memoryKey ?? undefined;
}

export function getStoredKeySource(): 'env' | 'stored' | 'none' {
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) return 'env';
  ensureLoaded();
  return memoryKey ? 'stored' : 'none';
}

export function getRawStoredKey(): string | undefined {
  ensureLoaded();
  return memoryKey ?? undefined;
}

export function isEnvConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim();
}

export function isStoredConfigured(): boolean {
  ensureLoaded();
  return !!memoryKey;
}

export function setStoredKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Key cannot be empty');
  if (trimmed.length < 10) throw new Error('Key too short');
  if (trimmed.length > 2048) throw new Error('Key too long');
  memoryKey = trimmed;
  memoryLoaded = true;
  // Best-effort persistence: file may be read-only on serverless (Vercel, Netlify, Replit).
  // Keep in-memory key even if write fails — it survives until process restarts,
  // and env var can be used for permanent storage.
  try {
    const p = storePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ key: trimmed, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn('OpenRouter key will be kept in memory only (file persistence failed):', error instanceof Error ? error.message : String(error));
    // Do not throw — in-memory key is still usable for this process lifetime.
  }
}

export function clearStoredKey(): void {
  memoryKey = undefined;
  memoryLoaded = true;
  try {
    const p = storePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (error) {
    console.warn('Failed to clear persisted OpenRouter key file (in-memory cleared):', error instanceof Error ? error.message : String(error));
  }
}

export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  const t = key.trim();
  if (!t) return null;
  if (t.length <= 8) return '•'.repeat(t.length);
  const visible = t.slice(0, 8);
  const maskedLen = Math.min(20, t.length - 8);
  return `${visible}${'•'.repeat(maskedLen)}`;
}

export function validateKeyFormat(key: string): { ok: boolean; error?: string } {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: 'Paste your OpenRouter API key. Find it at https://openrouter.ai/keys — it starts with sk-or-v1-.' };
  if (trimmed.length < 10) return { ok: false, error: 'That key length looks invalid. Copy the full key from openrouter.ai/keys.' };
  if (trimmed.length > 2048) return { ok: false, error: 'That key is too long. Copy only the key from openrouter.ai/keys.' };
  if (!trimmed.startsWith('sk-')) return { ok: false, error: 'OpenRouter keys start with sk-or-v1-. Paste the full key from https://openrouter.ai/keys.' };
  if (/\s/.test(trimmed)) return { ok: false, error: 'The key contains whitespace. Paste only the key characters.' };
  return { ok: true };
}

export function resetForTests(): void {
  memoryKey = null;
  memoryLoaded = false;
}
