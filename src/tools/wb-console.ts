import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { statSync } from "node:fs";
import { findActiveLogDir, readFrom, WB_LOGS_DIR } from "../utils/wb-log.js";

/** Cap returned text so a 300 KB log never floods the context. */
const MAX_OUTPUT_CHARS = 60_000;

const LOG_FILES = ["console", "script", "error", "crash"] as const;

export function registerWbConsole(server: McpServer): void {
  server.registerTool(
    "wb_console",
    {
      description:
        "Read the live Workbench log from disk (newest-mtime logs_* folder). " +
        "Use after a Play test or a compile to see runtime output — script prints, " +
        "VM exceptions, resource errors. Supports a regex filter, e.g. '\\\\[JWK\\\\]|\\\\[FFRX\\\\]' " +
        "or 'SCRIPT +\\\\(E\\\\)'.",
      inputSchema: {
        file: z
          .enum(LOG_FILES)
          .default("console")
          .describe("Which log in the active folder: console.log, script.log, error.log, crash.log"),
        pattern: z
          .string()
          .optional()
          .describe("Regex; only matching lines are returned (case-insensitive)"),
        tailLines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(120)
          .describe("Return at most this many lines, from the end"),
        tailBytes: z
          .number()
          .int()
          .min(1024)
          .max(4_000_000)
          .default(400_000)
          .describe("Only scan this many bytes from the end of the file"),
      },
    },
    async ({ file, pattern, tailLines, tailBytes }) => {
      const logDir = findActiveLogDir();
      if (!logDir) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No \`logs_*\` folder under \`${WB_LOGS_DIR}\`. Is the Workbench running?`,
            },
          ],
          isError: true,
        };
      }

      const path = join(logDir, `${file}.log`);
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        return {
          content: [{ type: "text" as const, text: `\`${path}\` does not exist.` }],
          isError: true,
        };
      }

      let re: RegExp | undefined;
      if (pattern) {
        try {
          re = new RegExp(pattern, "i");
        } catch (e) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid pattern: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          };
        }
      }

      const offset = Math.max(0, size - tailBytes);
      const text = readFrom(path, offset);
      let lines = text.split("\n");
      // A non-zero offset almost certainly lands mid-line; drop that fragment.
      if (offset > 0 && lines.length > 1) lines = lines.slice(1);
      if (re) lines = lines.filter((l) => re!.test(l));

      const total = lines.length;
      let out = lines.slice(-tailLines).join("\n");
      if (out.length > MAX_OUTPUT_CHARS) out = out.slice(-MAX_OUTPUT_CHARS);

      const header =
        `\`${path}\` (${size} bytes)` +
        (re ? ` — ${total} line(s) matching \`${pattern}\`` : "") +
        (total > tailLines ? `, showing last ${tailLines}` : "");

      return {
        content: [{ type: "text" as const, text: `${header}\n\n\`\`\`\n${out}\n\`\`\`` }],
      };
    }
  );
}
