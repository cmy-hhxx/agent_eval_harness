import path from "node:path";
import { DEFAULT_POLICY } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, ToolRuntime } from "@eval/tools";

const workdir = process.argv[2];
const runtime = new ToolRuntime(
  {
    attemptId: "orphan-test",
    workdir,
    inputs: new Map(),
    policy: DEFAULT_POLICY,
    audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
    artifacts: new ArtifactStore(path.join(workdir, "artifacts")),
  },
  createRegistry().select(["execute_code"]),
);
await runtime.execute(
  "execute_code",
  {
    language: "python",
    code: 'import os,time\nfrom pathlib import Path\nPath("pid").write_text(str(os.getpid()))\ntime.sleep(30)',
  },
  new AbortController().signal,
);
