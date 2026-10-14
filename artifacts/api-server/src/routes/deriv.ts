import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

// Fallback relay for Deriv's Options REST API.
//
// The browser calls https://api.derivws.com directly first. If a browser blocks
// that cross-origin read, the client retries through this same-origin route,
// which forwards the caller's Authorization and Deriv-App-ID headers verbatim.
// Only Deriv's Options API paths are relayed, so this cannot act as an open
// proxy, and nothing is logged beyond the status and path.
const DERIV_REST_BASE = (process.env.DERIV_REST_BASE ?? "https://api.derivws.com").replace(/\/+$/, "");
const ALLOWED_PATH = /^\/trading\/v1\/options\//;
const UPSTREAM_TIMEOUT_MS = 20_000;

const router: IRouter = Router();

function failure(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    errors: [{ status, code, message }],
    meta: { endpoint: "/api/deriv", method: "PROXY" },
  });
}

router.use("/deriv", async (req: Request, res: Response) => {
  const relativeUrl = req.url.startsWith("/deriv") ? req.url.slice("/deriv".length) : req.url;
  const [path, query] = relativeUrl.split("?", 2);
  if (!path || !ALLOWED_PATH.test(path)) {
    failure(res, 404, "NotFound", "Only Deriv Options API paths are relayed here.");
    return;
  }

  const headers: Record<string, string> = {};
  const authorization = req.header("authorization");
  const appId = req.header("deriv-app-id");
  if (authorization) headers.Authorization = authorization;
  if (appId) headers["Deriv-App-ID"] = appId;
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined && req.body !== null;
  if (hasBody) headers["Content-Type"] = "application/json";

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${DERIV_REST_BASE}${path}${query ? `?${query}` : ""}`, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error, path }, "Deriv REST relay failed");
    failure(res, 502, "UpstreamUnavailable", "Deriv could not be reached from this workspace service.");
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("Cache-Control", "no-store");
  if (!text) {
    failure(res, 502, "UpstreamEmpty", "Deriv returned an empty response.");
    return;
  }
  try {
    res.type("application/json").send(text);
  } catch {
    failure(res, 502, "UpstreamMalformed", "Deriv returned a response that could not be relayed.");
  }
});

export default router;
