import { messageContentSources } from "@eval/contracts";

/** Exact standalone capture envelopes; neither status records the original user-facing rendering. */
export function visualCaptureMarkers(message: unknown) {
  return messageContentSources(message).flatMap(source => {
    let value: unknown;
    try { value = JSON.parse(source.text); } catch { return []; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const marker = value as Record<string, unknown>;
    if (Object.keys(marker).length !== 2 || typeof marker.ref !== "string" || !marker.ref.trim()) return [];
    const status = marker.jgy_visual === "skipped" && marker.ref.startsWith("jgy-") ? "skipped"
      : marker.visual === "unsupported" && marker.ref.startsWith("html-") ? "unsupported" : undefined;
    return status ? [{ ...source, status, resource_ref: marker.ref }] : [];
  });
}
