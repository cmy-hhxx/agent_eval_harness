import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { providerFetch } from "./provider-http.js";

test("model connections can outlast Node's 10-second default and still honor cancellation", { timeout: 15000 }, async () => {
  const sockets = new Set<Socket>();
  // Accept TCP but delay the TLS handshake, as a congested gateway can.
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const signal = AbortSignal.timeout(11000);
    await assert.rejects(providerFetch(`https://127.0.0.1:${port}`, { signal }), error => {
      assert(signal.aborted, "the provider connection must wait past the default 10-second connect timeout");
      return error instanceof Error && error.name === "TimeoutError";
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
