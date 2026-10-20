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
      // Not JSON — treat raw as key if it looks like a key
      if (raw.startsWith('sk-')) return raw;
      // Fallback: if raw length plausible, return it
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
  try {
    const p = storePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ key: trimmed, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch (error) {
    // Memory still holds; surface error for API layer to report
    console.error('Failed to persist OpenRouter key:', error);
    throw new Error('Server could not persist the API key. Check server file permissions.');
  }
}

export function clearStoredKey(): void {
  memoryKey = undefined;
  memoryLoaded = true;
  try {
    const p = storePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (error) {
    console.error('Failed to clear OpenRouter key:', error);
    throw new Error('Server could not clear the stored key.');
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

export function resetForTests(): void {
  memoryKey = null;
  memoryLoaded = false;
}
