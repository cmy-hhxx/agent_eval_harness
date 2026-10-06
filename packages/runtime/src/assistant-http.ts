import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { localFiles, assistantUser } from "@eval/data";
import { errorText } from "@eval/contracts";
import { Context, RemoteStreamMuxServer, rpcFetchHandler, bootThemeInjections, RemoteStreamCarrierError } from "./deepseek.js";

export interface AssistantEndpoints {
  call(userId: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>;
  stream(userId: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>;
  dispose(): Promise<void>;
  artifact?(userId: string, sessionId: string, id: string): Promise<Uint8Array>;
}
export async function serveAssistant(options: { port: number; userId: string; webDirectory: string; endpoints(url: string): AssistantEndpoints; onError?(error: unknown): void }) {
  const contexts = new Set<Context>();
  const peers = new Map<string, string>();
  const lifetime = new AbortController();
  const failure = (error: unknown) => ({ code: "gateway/invocation", message: errorText(error), details: {} });
  let endpoints: AssistantEndpoints;
  const mux = new RemoteStreamMuxServer(async (endpoint, payload, _uplink, peer, control) => {
    const stream = await endpoints.stream(peers.get(peer.id)!, endpoint, payload, control.signal);
    return (async function* () {
      try { yield* stream; }
      catch (error) {
        if (error instanceof RemoteStreamCarrierError) await peer.dispose();
        throw error;
      }
    })();
  }, failure, 2000, 8 * 1024 * 1024);
  const parse = (url: URL) => {
    const match = /^\/u\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match) return undefined;
    return { userId: assistantUser(decodeURIComponent(match[1])), resource: match[2], base: `/u/${match[1]}/` };
  };
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); return; }
      const route = parse(url);
      if (!route) {
        const userId = assistantUser(url.searchParams.get("user") ?? options.userId);
        res.writeHead(302, { location: `/u/${userId}/` }); res.end(); return;
      }
      if (route.resource.startsWith("api/")) {
        const ctx = new Context(), peer = { id: randomUUID(), ctx, dispose: () => ctx.fiber.dispose() };
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
          const request = new Request(`http://localhost${url.pathname}`, { method: req.method, headers: { "content-type": String(req.headers["content-type"] ?? "") }, ...(req.method === "POST" ? { body: Buffer.concat(chunks).toString("utf8") } : {}), signal: AbortSignal.any([abort.signal, lifetime.signal]) });
          const result = await rpcFetchHandler(`${route.base}api`, async (endpoint, payload, signal) => {
            try { return { ok: true, value: await endpoints.call(route.userId, endpoint, payload, signal) }; }
            catch (error) { return { ok: false, error: failure(error) }; }
          }, peer).fetch(request);
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(Buffer.from(await result.arrayBuffer()));
        } finally { await ctx.fiber.dispose(); }
        return;
      }
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const artifact = /^artifacts\/([\w-]+)\/([\w-]+)\.md$/.exec(route.resource);
      if (artifact && endpoints.artifact) {
        const content = await endpoints.artifact(route.userId, artifact[1], artifact[2]);
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${artifact[2]}.md"`, "cache-control": "no-store" });
        res.end(content); return;
      }
      const resource = route.resource || "index.html";
      const file = path.resolve(options.webDirectory, decodeURIComponent(resource));
      if (!file.startsWith(path.resolve(options.webDirectory) + path.sep)) { res.writeHead(404); res.end(); return; }
      const content = await localFiles.read(file);
      const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
      res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
      if (resource === "index.html") {
        const injection = bootThemeInjections("light");
        res.setHeader("cache-control", "no-store");
        res.end(content.toString("utf8").replace("<!--agent-theme-->", injection.filter((row) => row.kind === "style").map((row) => `<style>${row.text}</style>`).join("")).replace("<body>", `<body>${injection.filter((row) => row.kind === "script").map((row) => `<script>${row.text}</script>`).join("")}`));
      } else { res.setHeader("cache-control", path.extname(file) === ".html" ? "no-store" : "public,max-age=31536000,immutable"); res.end(content); }
    } catch (error) {
      options.onError?.(error);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" }); res.end(errorText(error));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      const route = parse(new URL(req.url ?? "/", "http://localhost"));
      if (!route || route.resource !== "api/remote.mux") { socket.destroy(); return; }
      const ctx = new Context(), id = randomUUID();
      contexts.add(ctx); peers.set(id, route.userId);
      const peer = { id, ctx, dispose: async () => { contexts.delete(ctx); peers.delete(id); await ctx.fiber.dispose(); } };
      socket.once("close", () => { void peer.dispose(); });
      mux.handleUpgrade(req, socket, head, peer);
    } catch { socket.destroy(); }
  });
  server.listen(options.port, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  const url = `http://127.0.0.1:${address.port}`;
  endpoints = options.endpoints(url);
  return { url, async close() {
    lifetime.abort(); await mux.close(); await endpoints.dispose();
    for (const ctx of contexts) await ctx.fiber.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
