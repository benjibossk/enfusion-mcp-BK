/**
 * Live Workbench log reading.
 *
 * The running Workbench writes to the newest `logs_<ts>` folder under
 * `~/Documents/My Games/ArmaReforgerWorkbench/logs`. Unlike a headless build
 * (which creates a *new* folder we can watch for), that folder already exists,
 * so we track progress by byte offset into `console.log`.
 *
 * Note: the Script Editor's "Validate Scripts" (F7) writes NOTHING to disk —
 * its output only reaches the GUI Debug pane. "Validate and Reload Scripts"
 * (Shift+F7) is the only variant that logs, which is why wb_compile uses it.
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const WB_LOGS_DIR = join(
  homedir(),
  "Documents",
  "My Games",
  "ArmaReforgerWorkbench",
  "logs"
);

/** Markers bounding one Shift+F7 cycle in console.log. */
export const RELOAD_START_RE = /SCRIPT\s+:\s+Reloading game scripts/;
export const RELOAD_END_RE = /PROFILING\s+:\s+Reloading game scripts took:\s*([\d.]+)\s*ms/;

/** Hot-reload always discards the old VM state; these are noise, not errors. */
const LEAK_NOISE_RE = /Leaked '.*' script instance/;

export interface ScriptDiagnostic {
  severity: "E" | "W";
  /** Script-relative path, e.g. "Scripts/Game/Foo.c". Null when the engine gave no location. */
  file: string | null;
  line: number | null;
  message: string;
  raw: string;
}

export interface CompileReport {
  errors: ScriptDiagnostic[];
  warnings: ScriptDiagnostic[];
  /** Warnings dropped because they did not match the path filter. */
  warningsFiltered: number;
  /** Milliseconds reported by the engine for the whole reload, if seen. */
  engineMs: number | null;
}

/**
 * Newest-*mtime* `logs_` folder — NOT newest name. Workbench keeps writing into
 * the folder it created at startup, so name order can lie after midnight or
 * when an older session is still alive.
 */
export function findActiveLogDir(): string | null {
  try {
    if (!existsSync(WB_LOGS_DIR)) return null;
    let best: string | null = null;
    let bestMs = -1;
    for (const name of readdirSync(WB_LOGS_DIR)) {
      if (!name.startsWith("logs_")) continue;
      const full = join(WB_LOGS_DIR, name);
      try {
        const st = statSync(full);
        if (st.isDirectory() && st.mtimeMs > bestMs) {
          best = full;
          bestMs = st.mtimeMs;
        }
      } catch {
        /* skip unreadable entry */
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Current byte length of a file, or 0 if it does not exist. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read a file from `offset` to EOF.
 *
 * Uses a positional read rather than readFileSync so a multi-hundred-KB
 * console.log is not re-read in full on every poll.
 */
export function readFrom(path: string, offset: number): string {
  let fd: number | null = null;
  try {
    const size = fileSize(path);
    if (size <= offset) return "";
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - offset);
    const read = readSync(fd, buf, 0, buf.length, offset);
    return buf.toString("utf-8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Parse `SCRIPT (E)` / `SCRIPT (W)` lines.
 *
 * Engine format is either
 *   `SCRIPT    (W): @"Scripts/Game/Foo.c,165": 'Bar' is obsolete`
 * or, with no location,
 *   `SCRIPT    (E): Virtual Machine Exception`
 */
export function parseScriptDiagnostics(
  text: string,
  warningPathFilter?: RegExp
): CompileReport {
  const errors: ScriptDiagnostic[] = [];
  const warnings: ScriptDiagnostic[] = [];
  let warningsFiltered = 0;
  let engineMs: number | null = null;

  for (const rawLine of text.split("\n")) {
    const endMatch = rawLine.match(RELOAD_END_RE);
    if (endMatch) engineMs = parseFloat(endMatch[1]);

    const m = rawLine.match(/SCRIPT\s+\((E|W)\):\s*(.*)$/);
    if (!m) continue;

    const severity = m[1] as "E" | "W";
    let body = m[2].trim();
    if (LEAK_NOISE_RE.test(body)) continue;

    let file: string | null = null;
    let line: number | null = null;
    const loc = body.match(/^@"([^"]+?),(\d+)":\s*(.*)$/);
    if (loc) {
      file = loc[1];
      line = parseInt(loc[2], 10);
      body = loc[3].trim();
    }

    const diag: ScriptDiagnostic = { severity, file, line, message: body, raw: rawLine.trim() };
    if (severity === "E") {
      errors.push(diag);
    } else if (warningPathFilter && !warningPathFilter.test(file ?? "")) {
      warningsFiltered++;
    } else {
      warnings.push(diag);
    }
  }

  return { errors, warnings, warningsFiltered, engineMs };
}

/** Format one diagnostic as `Scripts/Game/Foo.c:165 — message`. */
export function formatDiagnostic(d: ScriptDiagnostic): string {
  if (d.file) return `\`${d.file}:${d.line}\` — ${d.message}`;
  return d.message;
}
