import { errorText } from "@eval/contracts";
import { fileSourceReader } from "@eval/data";
import { comparisonWorkflow, createInputScanCache, listInputDates, listInputInventory, type EvalConfig } from "@eval/workflows/comparison";

/** Source revisions, not content hashes: a changed or missing file invalidates the projection. */
async function sourceRevision(config: EvalConfig) {
  return Promise.all(config.inputs.versions.map(async (version) => {
    try {
      const files = await fileSourceReader.files(version.sources);
      return [version.id, await Promise.all(files.map(async (file) => [file, await fileSourceReader.revision(file)]))];
    } catch (error) {
      return [version.id, "unavailable", errorText(error)];
    }
  }));
}

/** Per-dashboard read-only projections; no raw answers or evaluation results are cached. */
export function createDashboardInputs() {
  const scanFile = createInputScanCache();
  let inventory: {
    key: string;
    dates: ReturnType<typeof listInputDates>;
    value?: Awaited<ReturnType<typeof listInputInventory>>;
    error?: unknown;
  } | undefined;
  return {
    async read(config: EvalConfig) {
      const key = JSON.stringify([config.inputs, await sourceRevision(config)]);
      if (inventory?.key !== key) {
        const entry: NonNullable<typeof inventory> = { key, dates: listInputDates(config) };
        inventory = entry;
        // Discover dates first; full validation continues independently of the HTTP response.
        void entry.dates.then(() => listInputInventory(config, { scanFile })).then(
          (value) => { entry.value = value; },
          (error) => { entry.error = error; },
        );
      }
      const entry = inventory;
      const dates = await entry.dates;
      if (entry.error) {
        if (inventory === entry) inventory = undefined;
        throw entry.error;
      }
      return entry.value
        ? { status: "ready" as const, ...entry.value }
        : { status: "loading" as const, dates, issues: null };
    },
    async plan(config: EvalConfig) {
      return comparisonWorkflow.plan(config, { materializeInputs: false, scanFile });
    },
  };
}
