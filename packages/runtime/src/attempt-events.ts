import { appendFile, readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { redact, type AttemptStatus, type WorkerEvent } from "@eval/contracts";

/** Owns event ordering, durable batching and the live SSE fan-out for one attempt. */
export class AttemptEventLog {
  readonly events: WorkerEvent[] = [];
  private readonly clients = new Map<ServerResponse, number>();
  private saved = Promise.resolve();
  private persistedEvents = 0;
  private flushQueued = false;
  private ended = false;

  constructor(
    private readonly directory: string,
    private readonly attemptId: string,
    private readonly status: AttemptStatus,
    private readonly secret: string,
  ) {}

  append(type: WorkerEvent["type"], value: unknown): WorkerEvent {
    const data = JSON.parse(redact(JSON.stringify(value) ?? "null", [this.secret]));
    const event: WorkerEvent = {
      seq: this.events.length + 1,
      attemptId: this.attemptId,
      time: Date.now(),
      type,
      data,
    };
    this.events.push(event);
    this.status.lastSeq = event.seq;
    if (!this.flushQueued) {
      this.flushQueued = true;
      this.saved = this.saved.then(async () => {
        this.flushQueued = false;
        const batch = this.events.slice(this.persistedEvents);
        await appendFile(
          path.join(this.directory, "events.jsonl"),
          batch.map(item => JSON.stringify(item)).join("\n") + "\n",
        );
        this.persistedEvents += batch.length;
        for (const [client, cursor] of this.clients) {
          for (const event of batch) {
            if (client.destroyed || event.seq <= cursor) continue;
            client.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            this.clients.set(client, event.seq);
          }
        }
      });
    }
    return event;
  }

  async flush(): Promise<void> {
    await this.saved;
  }

  async stream(res: ServerResponse, after: number): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();
    await this.flush();
    for (const event of this.events) if (event.seq > after) writeEvent(res, event);
    if (this.ended) {
      res.end();
      return;
    }
    this.clients.set(res, Math.max(after, this.events.at(-1)?.seq || 0));
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 10000);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }

  async end(): Promise<void> {
    await this.flush();
    this.ended = true;
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
  }
}

export async function readAttemptEvents(directory: string): Promise<WorkerEvent[]> {
  const text = await readFile(path.join(directory, "events.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as WorkerEvent);
}

export function replayEventStream(
  res: ServerResponse,
  events: readonly WorkerEvent[],
  after: number,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();
  for (const event of events) if (event.seq > after) writeEvent(res, event);
  res.end();
}

function writeEvent(res: ServerResponse, event: WorkerEvent): void {
  res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}
