/** Bounded protocol probe; it is separate from evaluation judgments. */
export const modelProbeText = {
  system: "This is a protocol check. Call probe_echo exactly once with value set to probe. Read its result, then reply with only the returned token. Do not call any further tools.",
  prompt: "Run the protocol check now.",
  tool: "Return a fresh token. Call once with value set to probe, then copy only its returned token into the final answer.",
};
