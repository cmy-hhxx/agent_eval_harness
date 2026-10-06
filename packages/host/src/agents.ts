import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonical,
  presentSource,
  evidenceSelectionSchema,
  parseEvidenceCoordinates,
  resolveEvidenceSelectionDraft,
  validateEvidenceBank,
  type EvidenceBank,
  schemaIssues,
  ValidationError,
  submissionToolNames,
  type AgentDefinition,
  type JsonObject,
  type AgentBinding,
  type AgentProfile,
  type ToolAudit,
  type Policy,
  type FailureContext,
  type AgentRequest,
  type ValidationIssue,
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
      inspection?: ReturnType<Ajv2020["compile"]>;
      modelInspection?: ReturnType<Ajv2020["compile"]>;
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
          ...(profile.inspection ? { inspection: ajv.compile(profile.inspection.schema),
            modelInspection: ajv.compile(profile.inspection.modelSchema ?? profile.inspection.schema) } : {}),
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
  private feedback(profile: AgentProfile, request: AgentRequest, value: unknown, issues: ValidationIssue[]) {
    return issues.map(issue => {
      const context = profile.validationIssueContext?.(request, value, issue);
      if (!context || !Object.keys(context).length) return issue;
      const expected = issue.expected !== null && typeof issue.expected === "object" && !Array.isArray(issue.expected)
        ? issue.expected : issue.expected === undefined ? {} : { value: issue.expected };
      // Existing constraints win; a context hook cannot replace an error or its expected constraint.
      return { ...issue, expected: { ...context, ...expected } };
    });
  }
  /** A rejected HTTP payload cannot persist newly allocated choices. Reoffer only the durable directory. */
  private feedbackProjection<T>(binding: AgentBinding, value: T, bank: readonly string[]): T {
    const exactReference = (value: unknown): value is { evidence_id: string; observation?: unknown } =>
      !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonObject).evidence_id === "string" &&
      Object.keys(value).every(key => key === "evidence_id" || key === "observation");
    const reference = (value: { evidence_id: string; observation?: unknown }): JsonObject => {
      const index = bank.indexOf(value.evidence_id);
      if (index >= 0) return { evidence_index: index + 1, ...(value.observation !== undefined ? { observation: value.observation } : {}) };
      const coordinate = parseEvidenceCoordinates(value.evidence_id);
      const owners = coordinate ? Object.entries(binding.request.sources).filter(([, source]) => source.id === coordinate.input_id) : [];
      if (!coordinate || owners.length !== 1) return { repair_action: "此来源未提供可选编号；先读取本任务真实材料取得 reference.evidence_index。" };
      const candidate = owners[0]![0];
      return { read_request: coordinate.kind === "image" ? { tool: "view_image", arguments: { candidate, message_index: coordinate.message_index } }
        : { tool: "read_trace", arguments: { candidate, message_index: coordinate.message_index, path: coordinate.path,
          offset: coordinate.start, max_chars: Math.min(16000, Math.max(1, coordinate.end - coordinate.start)) } } };
    };
    const project = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(project);
      if (!value || typeof value !== "object") return value;
      if (exactReference(value)) return reference(value);
      const object = value as JsonObject;
      if (exactReference(object.reference) && !bank.includes(object.reference.evidence_id)) {
        const { reference: _reference, ...display } = object;
        const fallback = reference(_reference as { evidence_id: string; observation?: unknown });
        return { ...project(display) as JsonObject, ...(!Object.hasOwn(display, "read_request") ? fallback : {}) };
      }
      return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, project(item)]));
    };
    const shown = this.get(binding).profile.evidenceSelections ? project(value) : value;
    return this.presentSources(binding, shown) as T;
  }
  private presentSources<T>(binding: AgentBinding, value: T): T {
    let shown = value;
    const presentations = new Map(Object.values(binding.request.sources).flatMap(source =>
      source.presentation ? [[canonical(source.presentation), source.presentation] as const] : []));
    for (const presentation of presentations.values()) shown = presentSource(shown, presentation);
    return shown;
  }
  prepare(binding: AgentBinding) {
    const { profile } = this.get(binding);
    const modelInput = binding.modelInput ?? binding.request.input;
    if (profile.inspection && (!binding.modelInput || !binding.inspectionInput || !profile.toolNames.includes("inspect_material")))
      throw new Error(`Inspection requires separate primary and secondary material: ${binding.agent}/${binding.profile}`);
    const names = [...profile.toolNames, ...submissionToolNames(profile.fileSubmission)];
    if (typeof profile.fileSubmission !== "boolean" || new Set(names).size !== names.length ||
      Object.keys(profile.toolDescriptions).length !== names.length ||
      names.some((name) => !profile.toolDescriptions[name]?.trim()))
      throw new Error(`Incomplete tool descriptions: ${binding.agent}/${binding.profile}`);
    if (typeof profile.submissionNudge !== "string" || !profile.submissionNudge.trim())
      throw new Error(`Missing submission nudge: ${binding.agent}/${binding.profile}`);
    if (profile.fileSubmission && profile.jsonStringSubmission)
      throw new Error("A submission has exactly one transport encoding");
    if (profile.evidenceSelections && !binding.projectModelInput)
      throw new Error(`Evidence selections require an owned material projection: ${binding.agent}/${binding.profile}`);
    const evidenceBank: EvidenceBank = [];
    const shown = (input: JsonObject) => this.presentSources(binding,
      binding.projectModelInput?.(input, evidenceBank) ?? input);
    const outputSchema = profile.modelSubmissionSchema?.(binding.request) ?? profile.submissionSchema;
    return {
      evidenceBank,
      evaluation: {
        id: binding.agent,
        profile: binding.profile,
        systemPrompt: profile.systemPrompt,
        outputSchema: profile.evidenceSelections ? evidenceSelectionSchema(outputSchema) : outputSchema,
        ...(profile.inspection ? { inspectionSchema: profile.inspection.modelSchema ?? profile.inspection.schema } : {}),
        toolNames: profile.toolNames,
        fileSubmission: profile.fileSubmission,
        ...(profile.jsonStringSubmission ? {jsonStringSubmission:true} : {}),
        toolDescriptions: { ...profile.toolDescriptions },
        submissionNudge: profile.submissionNudge,
        requiredReads: profile.requiredReads?.(binding.request) ?? [],
        ...(Object.values(binding.request.sources).some(source => source.presentation) ? { sourcePresentations: Object.fromEntries(
          Object.entries(binding.request.sources).flatMap(([label, source]) => source.presentation ? [[label, structuredClone(source.presentation)]] : [])) } : {}),
      },
      prompt: profile.renderPrompt(shown(modelInput)),
      renderAttempt: (policy: Policy, recovery?: FailureContext) => {
        const previous = recovery?.evidenceBank ?? [];
        validateEvidenceBank(previous);
        evidenceBank.splice(0, evidenceBank.length, ...previous);
        const recoveryView = recovery ? { ...recovery, errors: this.feedbackProjection(binding,
          this.feedback(profile, binding.request, recovery.draft, recovery.errors), evidenceBank) } : undefined;
        if (!recovery?.inspection) return profile.renderPrompt(shown(modelInput), policy, recoveryView);
        const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, calculations: [], artifacts: [], evidenceBank,
          ...structuredClone(recovery.inspection.proof) };
        const revealed = this.inspectCanonical(binding, recovery.inspection.value, audit);
        return profile.renderPrompt(shown(revealed), policy, recoveryView);
      },
    };
  }
  resolveInspection(binding: AgentBinding, value: unknown, audit: ToolAudit): JsonObject {
    const { profile, modelInspection } = this.get(binding);
    if (!profile.inspection || !modelInspection) throw new ValidationError([{
      category: "decision", code: "inspection_unavailable", path: "/", message: "当前 Profile 未配置材料核查。",
    }]);
    const modelValid = modelInspection(value), issues = modelValid ? [] : schemaIssues(modelInspection.errors, value);
    const selected = profile.evidenceSelections ? resolveEvidenceSelectionDraft(value, audit.evidenceBank ?? []) : { value, issues: [] };
    issues.push(...selected.issues);
    if (issues.length) {
      // Canonical business validation still contributes safe independent coverage and read-proof gaps.
      // Its coordinate-schema errors are not model repair instructions for a numeric selection.
      try { profile.inspection.validate(binding.request, selected.value, audit); }
      catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        issues.push(...error.issues!.filter(issue => issue.category !== "structure" &&
          !selected.issues.some(selection => issue.path === selection.path || issue.path.startsWith(selection.path + "/"))));
      }
      throw new ValidationError(this.feedbackProjection(binding,[...new Map(issues.map(issue => [canonical(issue), issue])).values()], audit.evidenceBank ?? []));
    }
    const resolved = profile.inspection.resolve?.(binding.request, value, audit) ?? value;
    try { this.inspectCanonical(binding, resolved, audit); }
    catch (error) { if (!(error instanceof ValidationError)) throw error;
      throw new ValidationError(this.feedbackProjection(binding,error.issues!, audit.evidenceBank ?? [])); }
    return resolved as JsonObject;
  }
  projectMaterial(binding: AgentBinding, value: JsonObject, evidenceBank: EvidenceBank): JsonObject {
    return this.presentSources(binding, binding.projectModelInput?.(value, evidenceBank) ?? value);
  }
  /** Restoration validates canonical coordinates directly; it never reinterprets them as fresh model choices. */
  inspectCanonical(binding: AgentBinding, value: unknown, audit: ToolAudit): JsonObject {
    const { profile, inspection } = this.get(binding);
    if (!profile.inspection || !inspection || !binding.inspectionInput) throw new ValidationError([{
      category: "decision", code: "inspection_unavailable", path: "/", message: "当前 Profile 未配置材料核查。",
    }]);
    const valid = inspection(value), issues = valid ? [] : schemaIssues(inspection.errors, value);
    try { profile.inspection.validate(binding.request, value, audit); }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(...error.issues!);
    }
    if (issues.length) throw new ValidationError([...new Map(issues.map(issue => [canonical(issue), issue])).values()]);
    const context = profile.inspection.materialContext?.(binding.request, value, audit);
    return { ...structuredClone(binding.inspectionInput), material_inspection: structuredClone(value),
      ...(context ? { inspection_context: structuredClone(context) } : {}) };
  }
  resolve(binding: AgentBinding, draft: unknown, audit: ToolAudit): unknown {
    const { profile, submission } = this.get(binding);
    if (profile.inspection) {
      if (!audit.inspection) throw new ValidationError([{ category: "decision", code: "inspection_required", path: "/",
        message: "须先调用 inspect_material 完成独立原材料核查，再提交最终结果。" }]);
      this.inspectCanonical(binding, audit.inspection.value, { ...audit, ...audit.inspection.proof });
    }
    if (profile.evidenceSelections) {
      const rawSchema = evidenceSelectionSchema(profile.modelSubmissionSchema?.(binding.request) ?? profile.submissionSchema);
      const modelValidator = new Ajv2020({ allErrors: true, strict: false }).compile(rawSchema);
      const valid = modelValidator(draft), issues = valid ? [] : schemaIssues(modelValidator.errors, draft);
      const selected = resolveEvidenceSelectionDraft(draft, audit.evidenceBank ?? []);
      issues.push(...selected.issues);
      draft = selected.value;
      if (issues.length) {
        issues.push(...(profile.validateSubmission?.(binding.request, draft, audit) ?? []));
        throw new ValidationError(this.feedbackProjection(binding,this.feedback(profile, binding.request, draft,
          [...new Map(issues.map(issue => [canonical(issue), issue])).values()]), audit.evidenceBank ?? []));
      }
    }
    const valid = submission(draft);
    const issues = valid ? [] : schemaIssues(submission.errors, draft);
    issues.push(...(profile.validateSubmission?.(binding.request, draft, audit) ?? []));
    if (!valid) throw new ValidationError(this.feedbackProjection(binding,this.feedback(profile, binding.request, draft,
      [...new Map(issues.map(issue => [canonical(issue), issue])).values()]), audit.evidenceBank ?? []));
    let result: unknown = draft;
    try {
      if (binding.resolveSubmission && profile.resolve) throw new Error("Submission binding must have one owner");
      if (binding.resolveSubmission) result = binding.resolveSubmission(draft);
      else if (profile.resolve) result = profile.resolve(binding.request, draft, audit);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(...error.issues!);
    }
    if (issues.length) throw new ValidationError(this.feedbackProjection(binding,this.feedback(profile, binding.request, draft,
      [...new Map(issues.map(issue => [canonical(issue), issue])).values()]), audit.evidenceBank ?? []));
    return result;
  }
  validate(binding: AgentBinding, result: unknown, audit: ToolAudit): void {
    const { profile, result: resultValidator } = this.get(binding);
    if (!resultValidator(result)) throw new ValidationError(this.feedbackProjection(binding,this.feedback(profile, binding.request, result,
      schemaIssues(resultValidator.errors, result)), audit.evidenceBank ?? []));
    try {
      profile.validate?.(binding.request, result, audit);
    } catch (error) {
      if (!(error instanceof ValidationError) || (!profile.validationIssueContext && !profile.evidenceSelections)) throw error;
      throw new ValidationError(this.feedbackProjection(binding,this.feedback(profile, binding.request, result, error.issues!), audit.evidenceBank ?? []));
    }
  }
}
