// Local evaluation build has no built-in model catalog.
import type { Api, Model } from "./types.ts";
export const MODELS: Record<string, Record<string, Model<Api>>> = {};
