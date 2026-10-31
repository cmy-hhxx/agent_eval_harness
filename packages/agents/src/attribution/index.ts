export {checkAttributionLanguage,type AttributionLanguageField,type AttributionLanguageStatus} from './language.js';
import { type AgentDefinition } from "@eval/contracts";
import { componentAttributionProfile, sessionAssemblyProfile, sessionAttributionProfile, traceAttributionProfile } from "./session-profiles.js";
export { attributionNormDirectory, type AttributionNorm } from "./norm-directory.js";
export * from "./types.js";
export { sessionProblems, sessionProblemEntries, evidenceMessageIndex, sessionCorrectness } from "./session.js";
export { attributionComponentLabel, normalizeComponentFamily } from "./responsibility.js";
export { componentAttributionProfile, sessionAssemblyProfile, sessionAttributionProfile, sessionAttributionResultSchema, traceAttributionProfile } from "./session-profiles.js";
export const attributionAgent: AgentDefinition = {
  id: "attribution",
  profiles: { assembly: sessionAssemblyProfile, component: componentAttributionProfile, trace: traceAttributionProfile, session: sessionAttributionProfile },
};
