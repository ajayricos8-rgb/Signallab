import { Router, type IRouter } from "express";
import { AnalyzeTicksBody, AnalyzeTicksResponse } from "@workspace/api-zod";
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

export default router;