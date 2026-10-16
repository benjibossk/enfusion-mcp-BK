/**
 * Drives the Workbench Script Editor by keystroke.
 *
 * Why not the NET API: EMCP_WB_Reload calls ScriptEditor.ExecuteAction from
 * *inside* the script VM that the reload then destroys, so its JsonApiStruct
 * request/response are still alive at teardown and get reported as leaks. Doing
 * it from outside the process keeps the handler out of the picture entirely.
 *
 * It does NOT avoid the "Resources are leaking!" assertion box: crash.log shows
 * that box firing on plain manual Shift+F7 too. See startAssertionDismisser.
 *
 * Cost: it steals focus for roughly a second.
 */

import { execFile, spawn } from "node:child_process";
import { minimalEnv } from "./wb-env.js";

const SCRIPT_EDITOR_TITLE_PREFIX = "Script Editor";

const PS_SEND_SHIFT_F7 = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EmcpWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  const byte VK_SHIFT = 0x10;
  const byte VK_F7 = 0x76;
  const uint KEYEVENTF_KEYUP = 0x0002;
  // SendKeys (WScript.Shell COM) does not reliably reach the Enfusion Workbench's
  // Qt window; synthesising the keystroke with scancodes does.
  public static void ShiftF7() {
    byte sShift = (byte)MapVirtualKey(VK_SHIFT, 0);
    byte sF7 = (byte)MapVirtualKey(VK_F7, 0);
    keybd_event(VK_SHIFT, sShift, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(VK_F7, sF7, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    keybd_event(VK_F7, sF7, KEYEVENTF_KEYUP, IntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(VK_SHIFT, sShift, KEYEVENTF_KEYUP, IntPtr.Zero);
  }
  // Windows forbids a background process from stealing focus outright. Attaching
  // our input queue to the current foreground thread's lifts that restriction.
  public static bool Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    uint tgThread = GetWindowThreadProcessId(h, IntPtr.Zero);
    if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
    if (fgThread != tgThread) AttachThreadInput(tgThread, fgThread, true);
    ShowWindow(h, 9);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (fgThread != tgThread) AttachThreadInput(tgThread, fgThread, false);
    if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
    return GetForegroundWindow() == h;
  }
  public static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len == 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static IntPtr Find(string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (Title(h).StartsWith(prefix)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [EmcpWin]::Find('${SCRIPT_EDITOR_TITLE_PREFIX}')
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 0 }
$title = [EmcpWin]::Title($h)
$ws = New-Object -ComObject WScript.Shell
$ok = $false
foreach ($try in 1..4) {
  if ([EmcpWin]::Focus($h)) { $ok = $true; break }
  try { $ws.AppActivate($title) | Out-Null } catch { }
  Start-Sleep -Milliseconds 250
  if ([EmcpWin]::GetForegroundWindow() -eq $h) { $ok = $true; break }
}
Start-Sleep -Milliseconds 400
if (-not $ok -and [EmcpWin]::GetForegroundWindow() -ne $h) { Write-Output 'NOFOCUS'; exit 0 }
[EmcpWin]::ShiftF7()
Start-Sleep -Milliseconds 600
Write-Output 'SENT'
`;

/**
 * Watches for the engine's "Resources are leaking!" assertion box and clicks
 * Ignore.
 *
 * That box fires on essentially every script hot-reload in a heavily-modded
 * project — it is not caused by any particular caller, and it blocks the reload
 * until a human dismisses it. It is a plain Win32 abort/retry/ignore MessageBox,
 * so posting WM_COMMAND/IDIGNORE is enough.
 *
 * Runs as ONE long-lived PowerShell process for the whole compile rather than
 * re-spawning per poll, because each spawn pays a ~1s Add-Type compile.
 */
const PS_DISMISS_LOOP = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EmcpDlg {
  public delegate bool E(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, E cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  const uint WM_COMMAND = 0x0111;
  const int IDIGNORE = 5;
  const int IDNO = 7;
  static string Text(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len == 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  static bool IsWorkbench(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.StartsWith("ArmaReforgerWorkbench"); }
    catch { return false; }
  }
  // "Save changes?" Yes/No(/Cancel) message box raised by the Workbench on world/script reload:
  // answer No. Returns the dialog text of each one answered.
  public static System.Collections.Generic.List<string> DiscardSave() {
    var done = new System.Collections.Generic.List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(64);
      GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() != "#32770" || GetDlgItem(h, IDNO) == IntPtr.Zero || !IsWorkbench(h)) return true;
      StringBuilder body = new StringBuilder(Text(h));
      EnumChildWindows(h, delegate(IntPtr c, IntPtr q) { body.Append(" ").Append(Text(c)); return true; }, IntPtr.Zero);
      string t = body.ToString().ToLowerInvariant();
      // "This file has been modified by another program. Do you want to reload it?" (Script Editor):
      // the file on disk is the one just written by the tools -> Yes, never keep the stale buffer
      if (t.Contains("another program") || t.Contains("reload it")) {
        PostMessage(h, WM_COMMAND, new IntPtr(6), IntPtr.Zero); // IDYES
        done.Add("RELOADED file");
        return true;
      }
      if (t.Contains("save") || t.Contains("sauvegard") || t.Contains("modif") || t.Contains("changes")) {
        PostMessage(h, WM_COMMAND, new IntPtr(IDNO), IntPtr.Zero);
        done.Add(body.ToString().Replace((char)13, (char)32).Replace((char)10, (char)32));
      }
      return true;
    }, IntPtr.Zero);
    return done;
  }
  public static int DismissAll(string title) {
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString() == title) {
        PostMessage(h, WM_COMMAND, new IntPtr(IDIGNORE), IntPtr.Zero);
        n++;
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
$deadline = (Get-Date).AddMilliseconds(__DURATION__)
while ((Get-Date) -lt $deadline) {
  $n = [EmcpDlg]::DismissAll('Enfusion engine')
  if ($n -gt 0) { Write-Output "DISMISSED $n" }
  if (__DISCARD__) { foreach ($t in [EmcpDlg]::DiscardSave()) { Write-Output "DISCARDED $t" } }
  Start-Sleep -Milliseconds 400
}
`;

export interface AssertionDismisser {
  /** Stop watching and report how many assertion boxes were auto-ignored. */
  stop(): Promise<number>;
  /** Texts of the "save changes?" dialogs answered No so far. */
  discardedSaves(): string[];
}

/**
 * @param discardSavePrompts also answer No to the Workbench "save changes?" box. Only safe when
 *   the caller saves its own editor changes (wb_save) and edits world files on disk directly.
 */
export function startAssertionDismisser(durationMs: number, discardSavePrompts = false): AssertionDismisser {
  const script = PS_DISMISS_LOOP.replace("__DURATION__", String(Math.ceil(durationMs))).replace(
    "__DISCARD__",
    discardSavePrompts ? "$true" : "$false"
  );
  const discarded: string[] = [];
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let dismissed = 0;
  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { windowsHide: true, env: minimalEnv() }
  );
  proc.stdout.on("data", (chunk: Buffer) => {
    for (const m of chunk.toString().matchAll(/DISMISSED (\d+)/g)) {
      dismissed += parseInt(m[1], 10);
    }
    for (const m of chunk.toString().matchAll(/DISCARDED (.*)/g)) {
      discarded.push(m[1].trim());
    }
  });
  proc.on("error", () => {
    /* watcher is best-effort; a failure must not break the compile */
  });
  return {
    discardedSaves: () => discarded,
    stop(): Promise<number> {
      return new Promise((resolve) => {
        // The "Resources are leaking!" box often pops a few seconds AFTER the compile verdict (when the
        // NET API handler's response is torn down): keep watching for another minute in the
        // background instead of killing the watcher now, so it never stays on screen blocking the next call.
        if (proc.exitCode === null && !proc.killed) {
          const t = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              /* already gone */
            }
          }, 60_000);
          t.unref();
        }
        resolve(dismissed);
      });
    },
  };
}

export type SendKeyResult = "sent" | "no_window" | "no_focus" | "error";

export interface SendKeyOutcome {
  result: SendKeyResult;
  detail?: string;
}

/**
 * Focus the Script Editor window and press Shift+F7
 * (Build > Validate and Reload Scripts).
 */
export function sendValidateAndReload(): Promise<SendKeyOutcome> {
  // -EncodedCommand takes UTF-16LE base64, which sidesteps all shell quoting.
  const encoded = Buffer.from(PS_SEND_SHIFT_F7, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 30_000, windowsHide: true, env: minimalEnv() },
      (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        if (out.includes("SENT")) return resolve({ result: "sent" });
        if (out.includes("NOWINDOW")) return resolve({ result: "no_window" });
        if (out.includes("NOFOCUS")) return resolve({ result: "no_focus" });
        resolve({
          result: "error",
          detail: (stderr || "").trim() || (err ? err.message : out) || "unknown failure",
        });
      }
    );
  });
}
