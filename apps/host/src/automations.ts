import { configurationSecrets } from "./settings.js";
import { errorText, redact } from "@eval/contracts";
import { automationCommand } from "./automation-command.js";
import { logger } from "./composition.js";

await logger.initialize();
automationCommand(process.argv.slice(2)).catch(async (error) => {
  await logger.error(error, { component: "automations", event: "command_failed" });
  console.error(redact(errorText(error), configurationSecrets()));
  process.exitCode = 2;
});
