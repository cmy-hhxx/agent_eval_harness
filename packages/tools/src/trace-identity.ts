/** Preserve the original structured user timestamp without inferring one from text or the evaluation clock. */
export function originalUserTimestamp(raw: { messages: unknown[] }): string | null {
  const user = raw.messages.findLast(value => value !== null && typeof value === "object" &&
    !Array.isArray(value) && (value as { role?: unknown }).role === "user") as { timestamp?: unknown } | undefined;
  return typeof user?.timestamp === "string" ? user.timestamp : null;
}
