import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { once } from "node:events";
import { localFiles, assistantUser } from "@eval/data";
import { errorText } from "@eval/contracts";
import { Context, Peer, RemoteStreamMuxServer, rpcFetchHandler, bootThemeInjections, RemoteStreamCarrierError } from "./deepseek.js";

export interface AssistantEndpoints {
  call(userId: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>;
  stream(userId: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>;
  dispose(): Promise<void>;
}
export interface AssistantPrincipal { userId: string; loginId: string; expiresAt: number; internal?: boolean }
export interface AssistantAccess {
  publicOrigin: string;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  authenticate(req: IncomingMessage): Promise<AssistantPrincipal | undefined>;
  active?(principal: AssistantPrincipal): Promise<boolean>;
  onRevoke(listener: (userId: string, loginId?: string) => void): () => void;
}
export async function serveAssistant(options: { host?: string; access?: AssistantAccess; port: number; userId: string; webDirectory: string; endpoints(url: string): AssistantEndpoints; onError?(error: unknown): void }) {
  const contexts = new Set<Context>();
  const connections = new Set<{ principal: AssistantPrincipal; close(): void }>();
  const unwatch = options.access?.onRevoke((userId, loginId) => {
    for (const connection of connections) if (connection.principal.userId === userId && (!loginId || connection.principal.loginId === loginId)) connection.close();
  });
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
  }, failure, { heartbeatIntervalMs: 2000, streamInboxBytes: 8 * 1024 * 1024, compression: true });
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
      if (await options.access?.handle(req, res)) return;
      const principal = await options.access?.authenticate(req);
      if (options.access && !principal) {
        res.writeHead(req.method === "GET" && !url.pathname.includes("/api/") ? 303 : 401, { location: "/auth/login" }); res.end(); return;
      }
      if (options.access && !principal?.internal && req.method !== "GET" && req.headers.origin !== options.access.publicOrigin) { res.writeHead(403); res.end(); return; }
      const route = parse(url);
      if (route && principal && route.userId !== principal.userId) { res.writeHead(404); res.end(); return; }
      if (!route) {
        const userId = principal?.userId ?? assistantUser(url.searchParams.get("user") ?? options.userId);
        res.writeHead(302, { location: `/u/${userId}/` }); res.end(); return;
      }
      if (route.resource.startsWith("api/")) {
        const connection = principal && { principal, close: () => { abort.abort(); res.destroy(); } };
        if (connection) connections.add(connection);
        const expiry = principal && setTimeout(() => connection?.close(), Math.max(1, principal.expiresAt - Date.now()));
        const ctx = new Context(), peer = new Peer(ctx, { principal: { kind: "owner" }, interactions: "none" });
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
          const request = new Request(`http://localhost${url.pathname}`, { method: req.method, headers: { "content-type": String(req.headers["content-type"] ?? "") }, ...(req.method === "POST" ? { body: Buffer.concat(chunks).toString("utf8") } : {}), signal: AbortSignal.any([abort.signal, lifetime.signal]) });
          const result = await rpcFetchHandler(`${route.base}api`, async (endpoint, payload, signal) => {
            try { return { ok: true, value: await endpoints.call(route.userId, endpoint, payload, signal) }; }
            catch (error) { return { ok: false, error: failure(error) }; }
          }).fetch(request, peer);
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(Buffer.from(await result.arrayBuffer()));
        } finally { if (expiry) clearTimeout(expiry); if (connection) connections.delete(connection); await ctx.fiber.dispose(); }
        return;
      }
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const resource = route.resource || "index.html";
      const file = path.resolve(options.webDirectory, decodeURIComponent(resource));
      if (!file.startsWith(path.resolve(options.webDirectory) + path.sep)) { res.writeHead(404); res.end(); return; }
      const content = await localFiles.read(file);
      const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
      res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
      if (resource === "index.html") {
        const injection = bootThemeInjections("light");
        const accountMeta = principal && !principal.internal ? `<meta name="eris-auth" content="${principal.expiresAt}">` : "";
        res.setHeader("cache-control", "no-store");
        res.end(content.toString("utf8").replace("<!--agent-theme-->", accountMeta + injection.filter((row) => row.kind === "style").map((row) => `<style>${row.text}</style>`).join("")).replace("<body>", `<body>${injection.filter((row) => row.kind === "script").map((row) => `<script>${row.text}</script>`).join("")}`));
      } else { res.setHeader("cache-control", path.extname(file) === ".html" ? "no-store" : "public,max-age=31536000,immutable"); res.end(content); }
    } catch (error) {
      options.onError?.(error);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" }); res.end(errorText(error));
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    try {
      const route = parse(new URL(req.url ?? "/", "http://localhost"));
      const principal = await options.access?.authenticate(req);
      if (options.access && (!principal || !principal.internal && req.headers.origin !== options.access.publicOrigin || route?.userId !== principal.userId)) { socket.destroy(); return; }
      if (!route || route.resource !== "api/remote.mux") { socket.destroy(); return; }
      const ctx = new Context(), peer = new Peer(ctx, { principal: { kind: "owner" }, interactions: "none" });
      contexts.add(ctx); peers.set(peer.id, route.userId);
      const connection = principal && { principal, close: () => { socket.destroy(); void peer.dispose(); } };
      if (connection) connections.add(connection);
      // Internal owner streams reauthenticate the account while browser streams expire with their login.
      const expiry = principal && !principal.internal ? setTimeout(() => connection?.close(), Math.max(1, principal.expiresAt - Date.now())) : undefined;
      const validation = options.access ? setInterval(() => { void (options.access!.active ? options.access!.active(principal!) : options.access!.authenticate(req)).then(current => { if (!current) connection?.close(); }).catch(() => connection?.close()); }, 1000) : undefined;
      socket.once("close", () => { if (expiry) clearTimeout(expiry); if (validation) clearInterval(validation); if (connection) connections.delete(connection); contexts.delete(ctx); peers.delete(peer.id); void ctx.fiber.dispose(); });
      mux.handleUpgrade(req, socket, head, peer);
    } catch { socket.destroy(); }
  });
  server.listen(options.port, options.host ?? "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  const url = `http://127.0.0.1:${address.port}`;
  endpoints = options.endpoints(url);
  return { url, async close() {
    unwatch?.(); for (const connection of connections) connection.close(); lifetime.abort(); await mux.close(); await endpoints.dispose();
    for (const ctx of contexts) await ctx.fiber.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
