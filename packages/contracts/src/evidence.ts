/** A directly parseable source coordinate, with half-open UTF-16 text offsets. */
export function evidenceId(
  messageIndex: number,
  kind: "text" | "json" | "image",
  path = "",
  start = 0,
  end = 0,
): string {
  return kind === "image" ? `ev_${messageIndex}_image` : `ev_${messageIndex}_${kind}_${start}_${end}_${path}`;
}
