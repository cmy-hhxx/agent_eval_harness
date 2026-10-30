export {checkAttributionLanguage,type AttributionLanguageField,type AttributionLanguageStatus} from './language.js';
import { type AgentDefinition } from "@eval/contracts";
import { singleSessionAttributionProfile, sessionAttributionProfile, traceAttributionProfile } from "./session-profiles.js";
export { attributionNormDirectory, type AttributionNorm } from "./norm-directory.js";
export { numericReferenceDirectory } from "./units.js";
export * from "./types.js";
export { sessionProblems, evidenceMessageIndex, sessionCorrectness } from "./session.js";
export { attributionTableChecks } from "./table-review.js";
export { attributionComponentLabel } from "./responsibility.js";
export { singleSessionAttributionProfile, sessionAttributionProfile, sessionAttributionResultSchema, traceAttributionProfile } from "./session-profiles.js";
export const attributionAgent: AgentDefinition = {
  id: "attribution",
  profiles: { single: singleSessionAttributionProfile, trace: traceAttributionProfile, session: sessionAttributionProfile },
};
