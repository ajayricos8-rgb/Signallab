import { Router, type IRouter } from 'express';
import { OpenRouterError, openRouter, reviewRequestSchema } from '../lib/openrouter';
import { clearStoredKey, getStoredKey, getStoredKeySource, isEnvConfigured, maskKey, setStoredKey } from '../lib/openrouter-key-store.ts';

const router: IRouter = Router();

router.get('/openrouter/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await openRouter.status(req.query.refresh === '1'));
});

router.get('/openrouter/key', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = getStoredKey();
  const source = getStoredKeySource();
  res.json({
    configured: !!key,
    source,
    maskedKey: maskKey(key),
    envConfigured: isEnvConfigured(),
    message: key
      ? source === 'env'
        ? 'Key is configured via server environment (OPENROUTER_API_KEY). Manage it in your deployment secrets.'
        : 'Key is stored on the server via Settings. You can replace or clear it below.'
      : 'No OpenRouter key is configured. Paste your key below or set OPENROUTER_API_KEY on the API server.',
  });
});

router.post('/openrouter/key', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const raw = (req.body as any)?.key;
  if (typeof raw !== 'string' || !raw.trim()) {
    res.status(400).json({ error: 'Paste your OpenRouter API key. Find it at https://openrouter.ai/keys — it starts with sk-or-v1-.' });
    return;
  }
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 2048) {
    res.status(400).json({ error: 'That key length looks invalid. Copy the full key from openrouter.ai/keys.' });
    return;
  }
  if (!trimmed.startsWith('sk-')) {
    res.status(400).json({ error: 'OpenRouter keys start with sk-or-v1-. Paste the full key from https://openrouter.ai/keys.' });
    return;
  }
  // Extra guard: keys should be sk-or-v1-... but allow sk- prefix for future variant
  if (trimmed.includes(' ') || trimmed.includes('\n')) {
    res.status(400).json({ error: 'The key contains whitespace. Paste only the key characters.' });
    return;
  }
  try {
    setStoredKey(trimmed);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not save the API key.' });
    return;
  }
  openRouter.invalidateCache();
  // Verify immediately so UI gets connected/unavailable feedback
  const status = await openRouter.status(true);
  res.json(status);
});

router.delete('/openrouter/key', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (isEnvConfigured()) {
    res.status(400).json({ error: 'The server key comes from the OPENROUTER_API_KEY environment variable. Clear it in your deployment secrets instead of here.' });
    return;
  }
  try {
    clearStoredKey();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not clear the stored key.' });
    return;
  }
  openRouter.invalidateCache();
  const status = await openRouter.status(true);
  res.json(status);
});

router.post('/openrouter/analyze', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // A public browser may not spend this server's quota cross-origin.
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        res.status(403).json({ error: 'AI analysis must be requested from this app.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid request origin.' });
      return;
    }
  }
  const parsed = reviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid engine evidence for AI review.' });
    return;
  }
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try {
    res.json(await openRouter.review(parsed.data, controller.signal));
  } catch (error) {
    if (!res.destroyed) res.status(error instanceof OpenRouterError ? error.code : 503).json({
      error: error instanceof OpenRouterError ? error.message : 'OpenRouter analysis is unavailable. Engine results are unchanged.',
    });
  } finally { res.off('close', cancel); }
});

export default router;
