import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbReload(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Fire-and-forget script/plugin reload. PREFER wb_compile for .c edits: this tool reports " +
        "nothing about whether the code compiled, and triggering the reload from inside the script " +
        "VM makes the engine pop an 'Assertion failed — Resources are leaking!' modal the user must " +
        "dismiss by hand. Only use this when you deliberately do not want a result.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
      },
    },
    async ({ target }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });

        return {
          content: [
            {
              type: "text" as const,
              text: `**Reload Complete**\n\n${result.message || "Reload triggered."}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
