import "../../../vendor/deepseek/packages/client/web/src/base.css";
import "../../../vendor/deepseek/packages/client/ui-theme/src/styles/brand-font.css";
import { Context } from "@deepseek-ai/cordis";
import * as connection from "@deepseek-ai/dsh-client-connection/client";
import * as gateway from "@deepseek-ai/dsh-api-gateway/client";
import * as typert from "@deepseek-ai/dsh-typert-registry/client";
import * as session from "@deepseek-ai/dsh-api-session-controller/client";
import * as workspace from "@deepseek-ai/dsh-api-workspace-controller/client";
import * as fileUpload from "@deepseek-ai/dsh-client-file-upload/client";
import * as settings from "@deepseek-ai/dsh-client-ui-settings/client";
import * as settingsGeneral from "@deepseek-ai/dsh-client-ui-settings-general/client";
import * as locale from "@deepseek-ai/dsh-client-locale/client";
import * as theme from "@deepseek-ai/dsh-client-ui-theme/client";
import * as shortcuts from "@deepseek-ai/dsh-client-shortcuts/client";
import * as resources from "@deepseek-ai/dsh-client-resources/client";
import * as renderer from "@deepseek-ai/dsh-client-ui-renderer/client";
import * as layout from "@deepseek-ai/dsh-client-ui-layout/client";
import * as sidebar from "@deepseek-ai/dsh-client-ui-sidebar/client";
import * as uiSession from "@deepseek-ai/dsh-client-ui-session/client";
import * as uiWorkspace from "@deepseek-ai/dsh-client-ui-workspace/client";
import * as sidebarRight from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import * as conversation from "@deepseek-ai/dsh-client-ui-conversation/client";
import * as chat from "@deepseek-ai/dsh-client-ui-chat/client";
import * as trajectory from "@deepseek-ai/dsh-client-ui-trajectory/client";
import * as tool from "@deepseek-ai/dsh-client-ui-tool/client";
import * as inputTriggers from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import * as commands from "@deepseek-ai/dsh-client-ui-commands/client";
import * as modelSelection from "@deepseek-ai/dsh-client-ui-model-selection/client";
import * as modelFavorites from "./models.js";
import * as analysisToolViews from "./tools.js";
import * as erisBrand from "./brand.js";
import { contribution } from "../core/remote-contract.js";

// All presentation, stores, subscriptions and transport are the upstream plugins.
const ctx = new Context();
ctx.on("internal/error", (error) => { console.error(error); });
const pending = [renderer, typert, connection, gateway].map((plugin) => ctx.plugin(plugin.default ?? plugin));
await Promise.all(pending);
await ctx.remote.$mount(contribution);
await Promise.all([
  ctx.plugin(theme, { appearanceSelector: false }),
  ctx.plugin(settingsGeneral, { technicalRows: false }),
  ...[
  session, workspace, fileUpload, settings, locale, shortcuts, resources,
  layout, sidebar, erisBrand, uiSession, sidebarRight, chat, tool, trajectory, analysisToolViews, inputTriggers, commands, modelSelection, modelFavorites,
  ].map((plugin) => ctx.plugin(plugin.default ?? plugin)),
]);
await ctx.plugin(uiWorkspace, { allowFork: false, readOnlyWorkspace: true });
await ctx.plugin(conversation, { allowAttachments: false });
ctx.inject(["layout", "uiWorkspace", "uiConversation", "uiSession", "sessions", "sidebarRight"], () => {
  ctx.uiRenderer.mount(document.getElementById("root"));
});
window.addEventListener("pagehide", () => { void ctx.fiber.dispose(); }, { once: true });
