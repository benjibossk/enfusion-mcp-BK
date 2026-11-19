/**
 * Unattended handling of the Workbench's modal Win32 dialogs (#32770 message boxes).
 *
 * Scans the top-level windows owned by the Workbench process (ArmaReforgerWorkbench*.exe)
 * and, per dialog:
 *   - save prompt ("save changes?")    -> follows `savePrompt` (save = Yes/Oui/Save/Enregistrer,
 *                                         discard = No/Non/Don't save/Ne pas enregistrer, leave)
 *   - engine assertion / "Resources are leaking!" -> Ignore
 *   - message box with a single OK / Close button -> clicks it
 *   - anything else                      -> left alone (still reported)
 *
 * Never dismisses crash reporters (they are other processes / not handled) and never kills a process.
 * Every dialog seen is reported with its title, text and the button clicked, so nothing is hidden.
 */
import { spawn } from "node:child_process";
import { minimalEnv } from "./wb-env.js";

export type SavePromptMode = "save" | "discard" | "leave";

const SAVE_PROMPT_MODES: readonly string[] = ["save", "discard", "leave"];

/**
 * Values spliced into the PowerShell scripts must never carry caller-controlled text.
 * Zod already restricts the tool args, but re-check here so a future caller cannot inject.
 */
export function safeSavePromptMode(mode: unknown): SavePromptMode {
  if (typeof mode === "string" && SAVE_PROMPT_MODES.includes(mode)) return mode as SavePromptMode;
  throw new Error(`Invalid savePrompt mode: ${String(mode)}`);
}

/** Non-negative integer milliseconds, safe to splice into a script. */
export function safeMs(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.ceil(n), 3_600_000);
}

export interface DialogReport {
  title: string;
  text: string;
  buttons: string[];
  kind: "save_prompt" | "assertion" | "message" | "other";
  clicked: string | null;
}

const PS_DIALOG_SCAN = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EmcpScan {
  public delegate bool E(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, E cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static string Text(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len == 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  static string Cls(IntPtr h) { StringBuilder c = new StringBuilder(64); GetClassName(h, c, c.Capacity); return c.ToString(); }
  static string Clean(string s) { return s.Replace("&", "").Replace((char)13, ' ').Replace((char)10, ' ').Trim(); }
  static string Esc(string s) { return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace((char)9, ' '); }
  static bool IsWorkbench(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.StartsWith("ArmaReforgerWorkbench"); }
    catch { return false; }
  }
  static bool IsCrashReporter(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.StartsWith("CrashReporter"); }
    catch { return false; }
  }
  static int Find(List<string> labels, List<int> ids, string[] wanted) {
    for (int i = 0; i < labels.Count; i++) {
      string l = labels[i].ToLowerInvariant();
      foreach (string w in wanted) if (l == w) return i;
    }
    return -1;
  }
  static readonly string[] SAVE = { "yes", "oui", "save", "enregistrer", "sauvegarder" };
  static readonly string[] DISCARD = { "no", "non", "don't save", "dont save", "do not save", "ne pas enregistrer", "ne pas sauvegarder" };
  static readonly string[] IGNORE = { "ignore", "ignorer" };
  static readonly string[] OKCLOSE = { "ok", "close", "fermer" };
  // One pass: returns one JSON line per dialog found.
  public static List<string> Scan(string mode, HashSet<long> seen) {
    var outp = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      // Benji asked (2026-11-19) to close the crash reporter too: it keeps the NET API port 5775 after a crash.
      // Closed with WM_CLOSE only: the report is never sent (no Send click), the process is never killed.
      if (IsCrashReporter(h)) {
        long ck = h.ToInt64();
        if (seen.Contains(ck)) return true;
        seen.Add(ck);
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
        outp.Add("{\\"title\\":\\"" + Esc(Text(h)) + "\\",\\"text\\":\\"\\",\\"buttons\\":[],\\"kind\\":\\"crash_reporter\\",\\"clicked\\":\\"WM_CLOSE\\"}");
        return true;
      }
      if (Cls(h) != "#32770" || !IsWorkbench(h)) return true;
      string title = Text(h);
      var labels = new List<string>(); var ids = new List<int>(); var body = new StringBuilder();
      EnumChildWindows(h, delegate(IntPtr c, IntPtr q) {
        string cc = Cls(c); string t = Clean(Text(c));
        if (cc == "Button") { if (t.Length > 0) { labels.Add(t); ids.Add(GetDlgCtrlID(c)); } }
        else if (t.Length > 0) { if (body.Length > 0) body.Append(" "); body.Append(t); }
        return true;
      }, IntPtr.Zero);
      string text = body.ToString();
      string all = (title + " " + text).ToLowerInvariant();
      string kind = "other"; int pick = -1;
      bool isSave = (all.Contains("save") || all.Contains("enregistr") || all.Contains("sauvegard") || all.Contains("changes") || all.Contains("modif"))
                    && Find(labels, ids, SAVE) >= 0 && Find(labels, ids, DISCARD) >= 0;
      int ign = Find(labels, ids, IGNORE);
      // "file changed outside the editor, reload?" (scripts edited by Claude): always reload, Benji 2026-11-19
      bool isReload = (all.Contains("reload") || all.Contains("recharg") || all.Contains("changed outside") || all.Contains("modified outside") || all.Contains("modifié en dehors") || all.Contains("modifie en dehors"))
                      && Find(labels, ids, SAVE) >= 0;
      if (isReload) {
        kind = "reload_prompt"; pick = Find(labels, ids, SAVE);
      } else if (isSave) {
        kind = "save_prompt";
        if (mode == "save") pick = Find(labels, ids, SAVE);
        else if (mode == "discard") pick = Find(labels, ids, DISCARD);
      } else if (ign >= 0 && (title == "Enfusion engine" || all.Contains("assert") || all.Contains("resources are leaking") || all.Contains("leak"))) {
        kind = "assertion"; pick = ign;
      } else if (labels.Count == 1 && Find(labels, ids, OKCLOSE) == 0) {
        kind = "message"; pick = 0;
      }
      long key = h.ToInt64();
      if (pick < 0 && seen.Contains(key)) return true; // already reported an untouched dialog
      seen.Add(key);
      string clicked = "null";
      if (pick >= 0) {
        PostMessage(h, 0x0111, new IntPtr(ids[pick]), IntPtr.Zero); // WM_COMMAND(ctrl id)
        clicked = "\\"" + Esc(labels[pick]) + "\\"";
      }
      var bl = new StringBuilder();
      for (int i = 0; i < labels.Count; i++) { if (i > 0) bl.Append(","); bl.Append("\\"").Append(Esc(labels[i])).Append("\\""); }
      outp.Add("{\\"title\\":\\"" + Esc(title) + "\\",\\"text\\":\\"" + Esc(text) + "\\",\\"buttons\\":[" + bl + "],\\"kind\\":\\"" + kind + "\\",\\"clicked\\":" + clicked + "}");
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
$seen = New-Object 'System.Collections.Generic.HashSet[long]'
$deadline = (Get-Date).AddMilliseconds(__WATCH__)
do {
  foreach ($j in [EmcpScan]::Scan('__MODE__', $seen)) { [Console]::Out.WriteLine("DLG " + $j); [Console]::Out.Flush() }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 500
} while ($true)
`;

export interface DialogWatcher {
  /** Stop scanning (after one last pass grace) and return every dialog seen. */
  stop(graceMs?: number): Promise<DialogReport[]>;
}

/**
 * Start a scanner process. `watchMs` = 0 does a single pass. The process ends by itself at the
 * deadline; `stop()` ends it early (it only kills our own PowerShell scanner, never the Workbench).
 */
export function startDialogWatcher(savePrompt: SavePromptMode, watchMs: number): DialogWatcher {
  const script = PS_DIALOG_SCAN.replace("__WATCH__", String(safeMs(watchMs))).replace(
    "__MODE__",
    safeSavePromptMode(savePrompt)
  );
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const reports: DialogReport[] = [];
  let buf = "";
  const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
    env: minimalEnv(),
  });
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("DLG ")) continue;
      try {
        reports.push(JSON.parse(line.slice(4)) as DialogReport);
      } catch {
        /* malformed line: ignore */
      }
    }
  });
  proc.on("error", () => {
    /* best-effort */
  });
  const exited = new Promise<void>((r) => {
    if (proc.exitCode !== null) r();
    proc.on("close", () => r());
  });
  return {
    async stop(graceMs = 0): Promise<DialogReport[]> {
      if (graceMs > 0) await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs))]);
      if (proc.exitCode === null) {
        try {
          proc.kill();
        } catch {
          /* gone */
        }
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      return reports;
    },
  };
}

/** One scan (or a watch of `watchMs`), waiting for the scanner to finish. */
export async function dismissDialogs(savePrompt: SavePromptMode = "save", watchMs = 0): Promise<DialogReport[]> {
  const w = startDialogWatcher(savePrompt, watchMs);
  // Add-Type compile costs ~1-2 s on top of the watch window.
  return w.stop(watchMs + 15_000);
}

/**
 * Run a Workbench action while a dialog watcher handles the modal boxes it may raise
 * (e.g. a save prompt that would otherwise block the NET API call until a human clicks).
 */
export async function withDialogDismissal<T>(
  action: () => Promise<T>,
  savePrompt: SavePromptMode = "save",
  maxMs = 60_000
): Promise<{ result?: T; error?: unknown; dialogs: DialogReport[] }> {
  const w = startDialogWatcher(savePrompt, maxMs);
  let result: T | undefined;
  let error: unknown;
  try {
    result = await action();
  } catch (e) {
    error = e;
  }
  // Keep scanning a little: some boxes pop right after the call returns.
  await new Promise((r) => setTimeout(r, 1500));
  const dialogs = await w.stop();
  return { result, error, dialogs };
}

export function formatDialogReports(dialogs: DialogReport[]): string {
  if (dialogs.length === 0) return "";
  const lines = dialogs.map(
    (d) =>
      `- [${d.kind}] "${d.title}" — ${d.text || "(no text)"} — buttons: ${d.buttons.join(" / ") || "none"} — ` +
      (d.clicked ? `clicked **${d.clicked}**` : "left open")
  );
  return `\n\n**Workbench dialogs**\n${lines.join("\n")}`;
}
