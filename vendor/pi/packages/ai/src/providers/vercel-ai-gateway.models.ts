// Local evaluation build: models are registered from the configured gateway.
import type { Model } from "../types.ts";
export const VERCEL_AI_GATEWAY_MODELS: Record<string, Model<never>> = {};
