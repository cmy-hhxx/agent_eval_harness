const inputUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** A registered source identity plus a directly parseable half-open UTF-16 coordinate. */
export function evidenceId(
  inputId: string,
  messageIndex: number,
  kind: "text" | "json" | "image",
  path = "",
  start = 0,
  end = 0,
): string {
  if (!inputUuid.test(inputId)) throw new RangeError("Evidence source must be a registered input UUID");
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 ||
    !["text", "json", "image"].includes(kind) || typeof path !== "string" ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
    throw new RangeError("Invalid evidence coordinate");
  return kind === "image" ? `ev_${inputId}_${messageIndex}_image` : `ev_${inputId}_${messageIndex}_${kind}_${start}_${end}_${path}`;
}

export type EvidenceCoordinates = { input_id: string; message_index: number; kind: "image" } |
  { input_id: string; message_index: number; kind: "text" | "json"; path: string; start: number; end: number };
/** Parse the current coordinate syntax; resolveEvidence validates the source, range and image audit. */
export function parseEvidenceCoordinates(id: string): EvidenceCoordinates | undefined {
  const uuid = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})";
  const image = new RegExp(String.raw`^ev_${uuid}_(\d+)_image$`, "u").exec(id);
  if (image && Number.isSafeInteger(Number(image[2])) && image[2] === String(Number(image[2]))) return { input_id: image[1]!, message_index: Number(image[2]), kind: "image" };
  const match = new RegExp(String.raw`^ev_${uuid}_(\d+)_(text|json)_(\d+)_(\d+)_([\s\S]*)$`, "u").exec(id);
  return match && [match[2], match[4], match[5]].every(value => Number.isSafeInteger(Number(value)) && value === String(Number(value)))
    ? { input_id: match[1]!, message_index: Number(match[2]), kind: match[3] as "text" | "json",
      start: Number(match[4]), end: Number(match[5]), path: match[6]! } : undefined;
}

/** Keep the public Attribution shape while retaining the complete reusable coordinate in position. */
export function attributionEvidencePosition(traceIndex: number, messageIndex: number, id: string): string {
  const point = parseEvidenceCoordinates(id);
  if (!point) throw new RangeError("Invalid attribution evidence coordinate");
  return `trace_index ${traceIndex} / message_index ${messageIndex} / path ${point.kind === "image" ? "image" : point.path || "root"} / evidence_id ${id}`;
}
export function attributionPositionReference(position: string): { evidence_id: string } | undefined {
  const id = / \/ evidence_id (ev_[\s\S]+)$/u.exec(position)?.[1];
  return id && parseEvidenceCoordinates(id) ? { evidence_id: id } : undefined;
}

/** Copy source metadata; the content of a model statement never becomes an execution observation. */
export function evidenceOrigin(message: unknown, path: string) {
  const row = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const root = row(message), origin: Record<string, string> = { field_path: path };
  for (const key of ["type", "role", "name", "model"])
    if (typeof root[key] === "string") origin[key] = root[key];
  let value: unknown = message;
  for (const part of path.split("/").slice(1)) {
    if (!value || typeof value !== "object") break;
    value = (value as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    const nested = row(value);
    if (typeof nested.role === "string" && Object.hasOwn(nested, "content")) {
      origin.enclosing_role = nested.role;
      if (typeof nested.name === "string") origin.enclosing_name = nested.name;
    }
  }
  return origin;
}

export const imagePlaceholder = "[图像数据，请使用 view_image]";
/** Also reject pages that cut through a placeholder rather than containing it in full. */
export function overlapsImagePlaceholder(text: string, start: number, end: number): boolean {
  const at = text.indexOf(imagePlaceholder, Math.max(0, start - imagePlaceholder.length + 1));
  return at >= 0 && at < end;
}
function isImageText(value: unknown, parent?: unknown, key?: string): boolean {
  if (typeof value !== "string") return false;
  if (/^data:image\//iu.test(value)) return true;
  if (key !== "data" || !parent || typeof parent !== "object") return false;
  const node = parent as Record<string, unknown>;
  return node.type === "image" && [node.mimeType, node.mime_type].some((mime) =>
    typeof mime === "string" && /^image\/\S+/iu.test(mime));
}
// Input messages are immutable during a run; each bind, bank check and tool read may
// render the same message again, so the walk and the serialized form are kept once.
const renderedMessages = new WeakMap<object, string>();
function renderMessage(value: unknown): string {
  const cached = value && typeof value === "object" ? renderedMessages.get(value) : undefined;
  if (cached !== undefined) return cached;
  const rendered = JSON.stringify(
    value,
    function (this: unknown, key, child: unknown) {
      return isImageText(child, this, key) ? imagePlaceholder : child;
    },
    2,
  );
  if (value && typeof value === "object") renderedMessages.set(value, rendered);
  return rendered;
}
function textLeaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return isImageText(value) ? [] : [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    isImageText(child, value, key) ? []
      : textLeaves(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}
const privateMarkers = ["private_instruction_omitted", "[此处内容未提供，不能据此判断原始内容为空或执行失败。]"];
const messageLeaves = new WeakMap<object, { kind: "text"; path: string; text: string; quotable?: false }[]>();
function textSources(message: unknown): { kind: "text"; path: string; text: string; quotable?: false }[] {
  const cached = message && typeof message === "object" ? messageLeaves.get(message) : undefined;
  if (cached) return cached;
  const leaves = textLeaves(message).map(([path, text]) => ({
    kind: "text" as const,
    path,
    text,
    ...(privateMarkers.some(marker => text.includes(marker)) ? { quotable: false as const } : {}),
  }));
  if (message && typeof message === "object") messageLeaves.set(message, leaves);
  return leaves;
}
export function evidenceSources(message: unknown): { kind: "text" | "json"; path: string; text: string; quotable?: false }[] {
  // Sources are immutable during a request. Leaf reads need no serialized copy of the whole message.
  let json: string | undefined;
  const rendered = () => json ??= renderMessage(message);
  // Callers own their array and entries; the cached walk is shared read-only.
  return [
    ...textSources(message).map(source => ({ ...source })),
    { kind: "json", path: "", get text() { return rendered(); },
      get quotable() { return privateMarkers.some(marker => rendered().includes(marker)) ? false as const : undefined; } },
  ];
}

/** Actual message prose, excluding modality labels, MIME types, URLs and other envelope metadata. */
export function messageContentSources(message: unknown): { kind: "text"; path: string; text: string }[] {
  const paths = new Set<string>();
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") { paths.add(path); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}/${index}`)); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    for (const key of ["text", "content"]) if (Object.hasOwn(node, key)) visit(node[key], `${path}/${key}`);
  };
  if (message && typeof message === "object") visit((message as Record<string, unknown>).content, "/content");
  return evidenceSources(message).flatMap(source => source.kind === "text" && source.text.length && paths.has(source.path)
    ? [{ ...source, kind: "text" as const }] : []);
}

/** Presence only; image observations and prior viewing remain separate audit requirements. */
export function evidenceImageAvailable(value: unknown): boolean {
  if (typeof value === "string") return /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/iu.test(value);
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return (node.type === "image" && typeof node.data === "string" && /^image\//iu.test(String(node.mimeType || node.mime_type || ""))) ||
    Object.values(node).some(evidenceImageAvailable);
}
