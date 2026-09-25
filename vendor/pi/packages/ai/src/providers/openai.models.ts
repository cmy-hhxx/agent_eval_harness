// Local evaluation build: models are registered from the configured gateway.
import type { Model } from "../types.ts";
export const OPENAI_MODELS: Record<string, Model<never>> = {};
