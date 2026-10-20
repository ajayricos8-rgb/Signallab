import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analysisRouter from "./analysis";
import derivRouter from "./deriv";

import openRouterRoutes from "./openrouter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(openRouterRoutes);
router.use(analysisRouter);
router.use(derivRouter);

export default router;
