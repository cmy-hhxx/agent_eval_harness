import { Agent, fetch as httpFetch } from "undici";

// Node's default 10-second TCP/TLS timeout can expire before a busy gateway connects.
// Keep this pool scoped to provider requests; caller signals still bound the whole request.
const connections = new Agent({ connect: { timeout: 60_000 } });
export const providerFetch: typeof fetch = (input, init) =>
  httpFetch(input as Parameters<typeof httpFetch>[0], { ...init, dispatcher: connections } as Parameters<typeof httpFetch>[1]) as unknown as ReturnType<typeof fetch>;
