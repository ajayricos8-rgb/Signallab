// Vercel's Express preset detects the import and deploys the bundled app.
// The normal Node server still uses src/index.ts and dist/index.mjs.
import "express";
export { default } from "./dist/app.mjs";
