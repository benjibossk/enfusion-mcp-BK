import { describe, it, expect } from "vitest";
import { safeMs, safeSavePromptMode } from "../../src/utils/wb-dialogs.js";
import { validateFilename } from "../../src/utils/safe-path.js";

describe("PowerShell splice guards", () => {
  it("accepts only the known save-prompt modes", () => {
    expect(safeSavePromptMode("save")).toBe("save");
    expect(safeSavePromptMode("discard")).toBe("discard");
    expect(safeSavePromptMode("leave")).toBe("leave");
    expect(() => safeSavePromptMode("save'); Remove-Item C:\ -Recurse; ('")).toThrow();
    expect(() => safeSavePromptMode(undefined)).toThrow();
  });

  it("coerces durations to bounded integers", () => {
    expect(safeMs(1500.2)).toBe(1501);
    expect(safeMs(-5)).toBe(0);
    expect(safeMs(Number.NaN)).toBe(0);
    expect(safeMs("1; calc")).toBe(0);
    expect(safeMs(1e12)).toBe(3_600_000);
  });
});

describe("building_setup manifest names", () => {
  it("rejects traversal in names used as file names", () => {
    expect(() => validateFilename("../../evil")).toThrow();
    expect(() => validateFilename("a/b")).toThrow();
    expect(() => validateFilename("wall_01")).not.toThrow();
  });
});
