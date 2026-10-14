/**
 * Minimal environment for spawned PowerShell.
 *
 * Add-Type shells out to the C# compiler, which fails with
 * "environment block ... cannot be larger than 65535 bytes" when it inherits a
 * bloated parent environment (an MCP host can easily carry several hundred KB).
 * Pass only what PowerShell and csc actually need.
 */

const MINIMAL_ENV_KEYS = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "OS",
];

export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    // Windows env vars are case-insensitive; process.env preserves the OS casing.
    const found = Object.keys(process.env).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found && process.env[found] !== undefined) env[key] = process.env[found];
  }
  return env;
}
