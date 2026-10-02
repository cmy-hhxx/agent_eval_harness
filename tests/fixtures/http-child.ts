import { HttpError } from "@eval/contracts";
import { json, listen } from "@eval/runtime/http";

const http = await listen((_req, res, url) => {
  if (url.pathname === "/sync-error") throw new HttpError(409, "Synchronous handler failure");
  if (url.pathname === "/async-error") return Promise.reject(new HttpError(422, "Asynchronous handler failure"));
  json(res, { path: url.pathname });
  return Promise.resolve();
});
process.send?.({ url: http.url });
process.on("disconnect", () => { void http.close(); });
