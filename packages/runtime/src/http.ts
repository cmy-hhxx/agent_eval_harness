import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpError, errorText, type JsonObject, type ValidationIssue } from "@eval/contracts";

export async function body(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, "Request too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export async function request<T>(
  url: string,
  method = "GET",
  value?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: signal ?? AbortSignal.timeout(30000),
  });
  const data = (await response.json()) as JsonObject;
  if (!response.ok)
    throw new HttpError(
      response.status,
      String(data.error || response.statusText),
      data.issues as ValidationIssue[] | undefined,
    );
  return data as T;
}

export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>,
  port = 0,
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      let url: URL;
      try { url = new URL(req.url || "/", "http://127.0.0.1"); }
      catch { throw new HttpError(400, "Invalid request URL"); }
      await handler(req, res, url);
    })().catch((error) => {
      if (res.headersSent) res.destroy();
      else
        json(
          res,
          {
            error: errorText(error),
            ...(error instanceof HttpError && error.issues ? { issues: error.issues } : {}),
          },
          error instanceof HttpError ? error.status : 500,
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
