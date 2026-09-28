import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentDefinition,
  type AgentBinding,
  type AgentProfile,
  type ToolAudit,
  type Policy,
  type FailureContext,
} from "@eval/contracts";

/** Profiles are registered by the application; the Host never imports a concrete Agent. */
export class AgentRegistry {
  private readonly profiles = new Map<
    string,
    {
      profile: AgentProfile;
      request: ReturnType<Ajv2020["compile"]>;
      submission: ReturnType<Ajv2020["compile"]>;
      result: ReturnType<Ajv2020["compile"]>;
    }
  >();
  constructor(definitions: AgentDefinition[]) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const definition of definitions)
      for (const [id, profile] of Object.entries(definition.profiles)) {
        const key = `${definition.id}/${id}`;
        if (this.profiles.has(key) || profile.id !== id)
          throw new Error(`Duplicate or mismatched profile: ${key}`);
        this.profiles.set(key, {
          profile,
          request: ajv.compile(profile.requestSchema),
          submission: ajv.compile(profile.submissionSchema),
          result: ajv.compile(profile.resultSchema || profile.submissionSchema),
        });
      }
  }
  private get(binding: AgentBinding) {
    const entry = this.profiles.get(`${binding.agent}/${binding.profile}`);
    if (!entry) throw new Error(`Unknown agent profile: ${binding.agent}/${binding.profile}`);
    if (!entry.request(binding.request.input))
      throw new ValidationError(schemaIssues(entry.request.errors, binding.request.input));
    return entry;
  }
  prepare(binding: AgentBinding) {
    const { profile } = this.get(binding);
    const names = [...profile.toolNames, "submit_evaluation", "submit_evaluation_file"];
    if (new Set(names).size !== names.length ||
      Object.keys(profile.toolDescriptions).length !== names.length ||
      names.some((name) => !profile.toolDescriptions[name]?.trim()))
      throw new Error(`Incomplete tool descriptions: ${binding.agent}/${binding.profile}`);
    if (typeof profile.submissionNudge !== "string" || !profile.submissionNudge.trim())
      throw new Error(`Missing submission nudge: ${binding.agent}/${binding.profile}`);
    return {
      evaluation: {
        id: binding.agent,
        profile: binding.profile,
        systemPrompt: profile.systemPrompt,
        outputSchema: profile.submissionSchema,
        toolNames: profile.toolNames,
        toolDescriptions: { ...profile.toolDescriptions },
        submissionNudge: profile.submissionNudge,
      },
      prompt: profile.renderPrompt(binding.request.input),
      renderAttempt: (policy: Policy, recovery?: FailureContext) =>
        profile.renderPrompt(binding.request.input, policy, recovery),
    };
  }
  resolve(binding: AgentBinding, draft: unknown, audit: ToolAudit): unknown {
    const { profile, submission } = this.get(binding);
    if (!submission(draft)) throw new ValidationError(schemaIssues(submission.errors, draft));
    return profile.resolve ? profile.resolve(binding.request, draft, audit) : draft;
  }
  validate(binding: AgentBinding, result: unknown, audit: ToolAudit): void {
    const { profile, result: resultValidator } = this.get(binding);
    if (!resultValidator(result)) throw new ValidationError(schemaIssues(resultValidator.errors, result));
    profile.validate?.(binding.request, result, audit);
  }
}
