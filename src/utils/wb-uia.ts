/**
 * Reads the Script Editor's "Errors" pane through UI Automation.
 *
 * Why this exists: a FAILED compile writes nothing to any log file. The Script
 * Editor aborts before the hot-reload and keeps the diagnostic list in its GUI
 * only. Qt does expose that pane over UIA as a grid with
 * Description | Addon | File | Line columns, which is strictly richer than what
 * console.log carries (the log has no addon attribution).
 *
 * The pane holds the result of the most recent compilation, so read it right
 * after triggering one.
 */

import { execFile } from "node:child_process";
import { minimalEnv } from "./wb-env.js";

const SEP = "\t";

const PS_READ_ERRORS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EmcpFind {
  public delegate bool E(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr Find(string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().StartsWith(prefix)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [EmcpFind]::Find('Script Editor')
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 0 }
$win = [System.Windows.Automation.AutomationElement]::FromHandle($h)
if ($win -eq $null) { Write-Output 'NO_UIA'; exit 0 }
$ctProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$treeCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Tree)
$trees = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeCond)
foreach ($tree in $trees) {
  # The errors grid is the only tree containing a "Configuration <name>" root row.
  $probe = $tree.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $isErrors = $false
  foreach ($x in $probe) { if ($x.Current.Name -like 'Configuration *') { $isErrors = $true; break } }
  if (-not $isErrors) { continue }
  $grid = $tree.GetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern)
  $rows = $grid.Current.RowCount
  $cols = $grid.Current.ColumnCount
  Write-Output ('OK ' + $rows)
  for ($r = 0; $r -lt $rows; $r++) {
    $cells = @()
    for ($c = 0; $c -lt $cols; $c++) {
      try { $cells += ($grid.GetItem($r, $c).Current.Name -replace "\`t", ' ') } catch { $cells += '' }
    }
    Write-Output ('R' + ($cells -join "\`t"))
  }
  exit 0
}
Write-Output 'NO_PANE'
`;

export interface EditorDiagnostic {
  severity: "error" | "warning" | "hint";
  description: string;
  /** Addon that owns the file, e.g. "EnfusionMCP". Empty when the engine gave none. */
  addon: string;
  file: string;
  line: number | null;
}

export interface ErrorsPaneResult {
  /** null when the pane could not be read; `diagnostics` is then empty. */
  status: "ok" | "no_window" | "no_uia" | "no_pane" | "error";
  detail?: string;
  diagnostics: EditorDiagnostic[];
  /** Counts as the pane itself reports them, e.g. "Errors(6):" -> 6. */
  reported: { errors: number | null; warnings: number | null; hints: number | null };
}

function emptyResult(status: ErrorsPaneResult["status"], detail?: string): ErrorsPaneResult {
  return {
    status,
    detail,
    diagnostics: [],
    reported: { errors: null, warnings: null, hints: null },
  };
}

/** Read the Errors pane. Never throws; failures come back as a status. */
export function readErrorsPane(timeoutMs = 60_000): Promise<ErrorsPaneResult> {
  const encoded = Buffer.from(PS_READ_ERRORS, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true, env: minimalEnv(), maxBuffer: 8_000_000 },
      (err, stdout, stderr) => {
        const out = (stdout || "").replace(/\r/g, "");
        if (out.includes("NO_WINDOW")) return resolve(emptyResult("no_window"));
        if (out.includes("NO_UIA")) return resolve(emptyResult("no_uia"));
        if (out.includes("NO_PANE")) return resolve(emptyResult("no_pane"));
        if (!out.startsWith("OK")) {
          return resolve(
            emptyResult("error", (stderr || "").trim() || (err ? err.message : out.slice(0, 300)))
          );
        }

        const result = emptyResult("ok");
        let section: EditorDiagnostic["severity"] | null = null;

        for (const raw of out.split("\n")) {
          if (!raw.startsWith("R")) continue;
          const cells = raw.slice(1).split(SEP);
          const description = (cells[0] ?? "").trim();
          const addon = (cells[1] ?? "").trim();
          const file = (cells[2] ?? "").trim();
          const lineStr = (cells[3] ?? "").trim();

          // Section headers look like "Errors(6):" and carry no file.
          const header = description.match(/^(Errors|Warnings|Hints)\((\d+)\):$/);
          if (header) {
            const n = parseInt(header[2], 10);
            if (header[1] === "Errors") {
              section = "error";
              result.reported.errors = n;
            } else if (header[1] === "Warnings") {
              section = "warning";
              result.reported.warnings = n;
            } else {
              section = "hint";
              result.reported.hints = n;
            }
            continue;
          }
          if (!file || section === null) continue; // "Configuration WORKBENCH" and friends

          result.diagnostics.push({
            severity: section,
            description,
            addon,
            file,
            line: lineStr ? parseInt(lineStr, 10) : null,
          });
        }
        resolve(result);
      }
    );
  });
}

/** Format as `Scripts/Game/Foo.c:5 — message [Addon]`. */
export function formatEditorDiagnostic(d: EditorDiagnostic): string {
  const loc = d.line !== null ? `${d.file}:${d.line}` : d.file;
  const addon = d.addon ? ` _[${d.addon}]_` : "";
  return `\`${loc}\` — ${d.description}${addon}`;
}
