import { Router, type IRouter } from 'express';
import { OpenRouterError, openRouter, reviewRequestSchema } from '../lib/openrouter';
import { clearStoredKey, getStoredKey, getStoredKeySource, isEnvConfigured, maskKey, setStoredKey, validateKeyFormat } from '../lib/openrouter-key-store.ts';

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

// Simple health for debugging connectivity without exposing key
router.get('/openrouter/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = getStoredKey();
  res.json({
    configured: !!key,
    source: getStoredKeySource(),
    maskedKey: maskKey(key),
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    note: 'Use GET /api/openrouter/status?refresh=1 to verify key via GET /key and fetch /models. Outbound to openrouter.ai must be allowed.',
  });
});

router.get('/openrouter/models', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const status = await openRouter.status(req.query.refresh === '1');
    res.json({ freeModels: status.freeModels, message: status.message, status: status.status, checkedAt: status.checkedAt });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not fetch models.' });
  }
});

router.post('/openrouter/key', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const raw = (req.body as any)?.key;
  const validation = validateKeyFormat(typeof raw === 'string' ? raw : '');
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const trimmed = (raw as string).trim();
  try {
    setStoredKey(trimmed);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not save the API key.' });
    return;
  }
  openRouter.invalidateCache();
  try {
    const status = await openRouter.status(true);
    res.json(status);
  } catch {
    // Fallback: key is saved locally even if verification throws synchronously
    res.json(await openRouter.status(true));
  }
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
