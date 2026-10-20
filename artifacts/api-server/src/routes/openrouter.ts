import { Router, type IRouter } from 'express';
import { OpenRouterError, openRouter, reviewRequestSchema } from '../lib/openrouter';

const router: IRouter = Router();

router.get('/openrouter/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await openRouter.status(req.query.refresh === '1'));
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
