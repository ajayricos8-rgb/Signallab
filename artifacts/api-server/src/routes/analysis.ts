import { Router, type IRouter } from "express";
import {
  AnalyzeCandleOpenBody,
  AnalyzeCandleOpenResponse,
  AnalyzeTicksBody,
  AnalyzeTicksResponse,
} from "@workspace/api-zod";
import { analyzeCandleOpen } from "../lib/candle-analysis-engine";
import { analyzeTicks } from "../lib/analysis-engine";

const router: IRouter = Router();

router.post("/analysis", (req, res): void => {
  const parsed = AnalyzeTicksBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.flatten() }, "Invalid tick analysis request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = analyzeTicks(parsed.data);
    res.json(AnalyzeTicksResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze tick window";
    req.log.warn({ error: message }, "Tick analysis failed");
    res.status(400).json({ error: message });
  }
});

router.post("/analysis/candle-open", (req, res): void => {
  const parsed = AnalyzeCandleOpenBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.flatten() }, "Invalid candle-open analysis request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = analyzeCandleOpen(parsed.data);
    res.json(AnalyzeCandleOpenResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze candle history";
    req.log.warn({ error: message }, "Candle-open analysis failed");
    res.status(400).json({ error: message });
  }
});

export default router;