import { Agent, fetch as httpFetch } from "undici";

// Node's default 10-second TCP/TLS timeout can expire before a busy gateway connects.
// A remote gateway is reached over a long-haul link, so an idle pooled socket must stay usable
// between evaluation calls instead of re-handshaking (and re-paying RTT) on every request.
// Keep this pool scoped to provider requests; caller signals still bound the whole request.
const connections = new Agent({ connect: { timeout: 60_000 }, keepAliveTimeout: 120_000, keepAliveMaxTimeout: 600_000, connections: 64 });
export const providerFetch: typeof fetch = (input, init) =>
  httpFetch(input as Parameters<typeof httpFetch>[0], { ...init, dispatcher: connections } as Parameters<typeof httpFetch>[1]) as unknown as ReturnType<typeof fetch>;
