import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import {
  findActiveLogDir,
  fileSize,
  readFrom,
  parseScriptDiagnostics,
  formatDiagnostic,
  RELOAD_START_RE,
  RELOAD_END_RE,
  WB_LOGS_DIR,
} from "../utils/wb-log.js";
import { sendValidateAndReload, startAssertionDismisser } from "../utils/wb-keys.js";
import { triggerValidateAndReload } from "../utils/wb-trigger.js";
import { readErrorsPane, formatEditorDiagnostic } from "../utils/wb-uia.js";

const POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 300_000;
/**
 * How long to wait for the "Reloading game scripts" marker before concluding the
 * compile pass rejected the scripts.
 *
 * A successful Shift+F7 logs that marker within a couple of seconds. A FAILED
 * one logs nothing at all: the Script Editor aborts before the hot-reload and
 * keeps the error list in its GUI Errors pane only — it never reaches disk.
 * So "no start marker" is our only failure signal.
 */
const NO_START_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerWbCompile(server: McpServer): void {
  server.registerTool(
    "wb_compile",
    {
      description:
        "Compile the currently loaded Workbench project and REPORT THE RESULT. " +
        "Presses Shift+F7 (Build > Validate and Reload Scripts) in the Script Editor, then reads " +
        "the live console.log and returns the script errors with file:line, plus a warning count. " +
        "Use this after editing any .c file instead of wb_reload — wb_reload is fire-and-forget and " +
        "tells you nothing about whether the code actually compiles. " +
        "Errors come from the Script Editor's Errors pane (read over UI Automation), so they are " +
        "reported even when the compile FAILS and no hot-reload happens — a failed compile writes " +
        "nothing to any log file. Each error carries addon, file and line. " +
        "Note: this steals window focus for about a second. Takes ~20-40s.",
      inputSchema: {
        timeoutMs: z
          .number()
          .int()
          .min(10_000)
          .max(900_000)
          .default(DEFAULT_TIMEOUT_MS)
          .describe("How long to wait for the compile-completion marker"),
        warningPathFilter: z
          .string()
          .optional()
          .describe(
            "Regex on the script path. Warnings whose file matches are listed individually; " +
              "all others are only counted. Example: 'FFRX|MinesIntegration'. " +
              "Omit to list no warnings at all (the base game emits hundreds)."
          ),
        maxErrors: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(40)
          .describe("Cap on individually listed errors"),
        autoDismissAssertions: z
          .boolean()
          .default(true)
          .describe(
            "Auto-click Ignore on the engine's 'Resources are leaking!' assertion box, which " +
              "otherwise blocks the reload until a human dismisses it. Set false to see it yourself."
          ),
        trigger: z
          .enum(["auto", "netapi", "keyboard"])
          .default("auto")
          .describe(
            "How to start the build. 'netapi' drives Build > Validate and Reload Scripts through " +
              "the EnfusionMCP handler: no window focus needed, nothing stolen from the user, and " +
              "it WORKS WITH THE WINDOWS SESSION LOCKED. 'keyboard' synthesises Shift+F7 and only " +
              "works unlocked. 'auto' (default) tries netapi then falls back to keyboard."
          ),
      },
    },
    async ({ timeoutMs, warningPathFilter, maxErrors, autoDismissAssertions, trigger }) => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      const logDir = findActiveLogDir();
      if (!logDir) {
        return fail(
          `**wb_compile failed** — no \`logs_*\` folder under \`${WB_LOGS_DIR}\`. Is the Workbench running?`
        );
      }
      const consolePath = join(logDir, "console.log");
      const startOffset = fileSize(consolePath);
      if (startOffset === 0) {
        return fail(`**wb_compile failed** — \`${consolePath}\` is missing or empty.`);
      }

      let filterRe: RegExp | undefined;
      if (warningPathFilter) {
        try {
          filterRe = new RegExp(warningPathFilter, "i");
        } catch (e) {
          return fail(
            `**wb_compile failed** — invalid warningPathFilter regex: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      // Start watching before the keystroke: the assertion can fire early in teardown.
      const dismisser = autoDismissAssertions
        ? startAssertionDismisser(timeoutMs + 10_000)
        : null;
      const stopDismisser = async (): Promise<number> => (dismisser ? dismisser.stop() : 0);

      // Two ways to trigger the build, NET API first:
      //
      //   netapi   — EMCP_WB_Reload calls ScriptEditor.ExecuteAction(Build > Validate
      //              and Reload Scripts). Same menu action as Shift+F7, but driven from
      //              inside the process: no focus needed, no focus stolen from the user,
      //              and crucially it works with the Windows session LOCKED.
      //              Requires the EnfusionMCP addon to be enabled.
      //   keyboard — synthesised Shift+F7. Only works unlocked, because Windows refuses
      //              SetForegroundWindow otherwise (-> "no_focus").
      //
      // Try the NET API, then fall back to the keyboard, which covers the case where the
      // EnfusionMCP addon is not loaded.
      let triggerNote: string;
      const viaNet = trigger === "keyboard" ? null : await triggerValidateAndReload();

      if (viaNet && viaNet.result === "sent") {
        triggerNote = `NET API — ${viaNet.detail}`;
      } else {
        if (trigger === "netapi") {
          await stopDismisser();
          return fail(
            `**wb_compile failed** — NET API trigger unavailable: ${viaNet?.detail ?? "unknown"}\n\n` +
              'Retry with `trigger: "auto"` to fall back to the keyboard, or check that the ' +
              "EnfusionMCP addon is enabled in the Workbench."
          );
        }

        const key = await sendValidateAndReload();
        if (key.result !== "sent") await stopDismisser();
        if (key.result === "no_window") {
          return fail(
            "**wb_compile failed** — no visible window whose title starts with `Script Editor`. " +
              "Open the Script Editor in the Workbench (it must be a top-level window) and retry."
          );
        }
        if (key.result === "no_focus") {
          return fail(
            "**wb_compile failed** — the NET API trigger was unavailable" +
              (viaNet ? ` (${viaNet.detail})` : "") +
              ", and Shift+F7 could not be sent either because the Script Editor refused the " +
              "foreground. That is exactly what happens when the Windows session is LOCKED. " +
              "Enable the EnfusionMCP addon so the NET API trigger works headless, or unlock " +
              "the session and retry."
          );
        }
        if (key.result === "error") {
          return fail(`**wb_compile failed** — could not send Shift+F7: ${key.detail}`);
        }
        triggerNote = "keyboard (Shift+F7)";
      }

      // Wait for the reload cycle to close. Starting from EOF means any marker we
      // see belongs to the run we just triggered, not an earlier one.
      const t0 = Date.now();
      let delta = "";
      let sawStart = false;
      let done = false;
      let noStart = false;
      while (Date.now() - t0 < timeoutMs) {
        await sleep(POLL_MS);
        delta = readFrom(consolePath, startOffset);
        if (!sawStart) sawStart = RELOAD_START_RE.test(delta);
        if (sawStart && RELOAD_END_RE.test(delta)) {
          done = true;
          break;
        }
        if (!sawStart && Date.now() - t0 > NO_START_MS) {
          noStart = true;
          break;
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const dismissed = await stopDismisser();

      // The Errors pane is authoritative: it holds the last compilation's result
      // whether or not the reload happened, and unlike the log it attributes each
      // diagnostic to an addon.
      const pane = await readErrorsPane();
      const logReport = parseScriptDiagnostics(delta, filterRe);
      const lines: string[] = [];

      const paneErrors = pane.diagnostics.filter((d) => d.severity === "error");
      const paneWarnings = pane.diagnostics.filter((d) => d.severity === "warning");
      const engineSec =
        logReport.engineMs !== null ? `${(logReport.engineMs / 1000).toFixed(1)}s` : `${elapsed}s`;

      if (pane.status !== "ok") {
        // Fall back to the log-only view.
        if (noStart) {
          return fail(
            `## Compile FAILED (probably) — no reload after ${elapsed}s\n\n` +
              "The Script Editor never logged `Reloading game scripts`, which means the compile pass " +
              "most likely rejected the scripts and aborted before the hot-reload.\n\n" +
              `The Errors pane could not be read either (\`${pane.status}\`${pane.detail ? `: ${pane.detail}` : ""}), ` +
              "so no error list is available — a failed compile writes nothing to disk. " +
              "Ask the user to read the Script Editor's **Errors** pane.\n\n" +
              `_Log: \`${consolePath}\`_`
          );
        }
        if (!done) {
          return fail(
            `**wb_compile TIMEOUT** after ${elapsed}s — the reload started but never finished. ` +
              "It may be blocked on a dialog waiting for input.\n\n" +
              `_Log: \`${consolePath}\`_`
          );
        }
        lines.push(`## Compile SUCCESS — reload completed (${engineSec})`);
        lines.push(
          `_Errors pane unreadable (\`${pane.status}\`); reporting from the log only._`
        );
        lines.push(`**Warnings in log:** ${logReport.warnings.length + logReport.warningsFiltered}`);
        for (const w of logReport.warnings.slice(0, maxErrors)) {
          lines.push(`- ${formatDiagnostic(w)}`);
        }
        lines.push(`\n_Log: \`${consolePath}\`_`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      if (paneErrors.length > 0) {
        lines.push(`## Compile FAILED — ${paneErrors.length} error(s)`);
        if (!done) {
          lines.push(
            "_No hot-reload happened: the running game still has the previous code._"
          );
        }
      } else if (done) {
        lines.push(`## Compile SUCCESS — 0 error, reloaded (${engineSec})`);
      } else {
        lines.push(`## Compile INCONCLUSIVE — no reload after ${elapsed}s, but 0 error reported`);
        lines.push(
          "_Shift+F7 may not have reached the Script Editor, or the reload is still running._"
        );
      }

      if (paneErrors.length > 0) {
        lines.push("\n### Errors");
        for (const e of paneErrors.slice(0, maxErrors)) {
          lines.push(`- ${formatEditorDiagnostic(e)}`);
        }
        if (paneErrors.length > maxErrors) {
          lines.push(`- …and ${paneErrors.length - maxErrors} more (raise \`maxErrors\`)`);
        }
      }

      const shown = filterRe
        ? paneWarnings.filter((w) => filterRe!.test(w.file) || filterRe!.test(w.addon))
        : [];
      lines.push(
        `\n**Warnings:** ${paneWarnings.length}` +
          (filterRe
            ? ` (${shown.length} matching filter)`
            : paneWarnings.length > 0
              ? " — pass `warningPathFilter` to list yours"
              : "")
      );
      for (const w of shown.slice(0, maxErrors)) {
        lines.push(`- ${formatEditorDiagnostic(w)}`);
      }

      if (dismissed > 0) {
        lines.push(
          `\n_Auto-ignored ${dismissed} engine assertion box(es) ("Resources are leaking!") — ` +
            `expected on hot-reload, not a code defect._`
        );
      }
      lines.push(`\n_Triggered via ${triggerNote}. Log: \`${consolePath}\`_`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
