// Golden tests for diagnostics. Each fixture in tests/fixtures/errors/ is
// named after the code it must produce (T0010_missing_colon.tejun -> T0010)
// and has a .expected file with the exact formatted output.
//
// To regenerate the .expected files on purpose:
//   Git Bash:    UPDATE_GOLDEN=1 npm test
//   PowerShell:  $env:UPDATE_GOLDEN=1; npm test; Remove-Item Env:UPDATE_GOLDEN

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES, check, formatDiagnostics } from "@tejun/compiler";

const dir = new URL("./fixtures/errors/", import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".tejun")).sort();
const update = process.env.UPDATE_GOLDEN === "1";

describe("diagnostic fixtures", () => {
  it.each(fixtures)("%s", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    const result = check(`tests/fixtures/errors/${file}`, text);
    expect(result.diagnostics.map((d) => d.code)).toEqual([file.slice(0, 5)]);

    const actual = formatDiagnostics(result.diagnostics, result.source);
    const expectedUrl = new URL(file.replace(/\.tejun$/, ".expected"), dir);
    if (update) writeFileSync(expectedUrl, actual, "utf8");
    const expected = readFileSync(expectedUrl, "utf8").replace(/\r\n/g, "\n");
    expect(actual).toBe(expected);
  });

  it("every syntax code (T00xx) has at least one fixture", () => {
    const covered = new Set(fixtures.map((f) => f.slice(0, 5)));
    const missing = Object.keys(DIAGNOSTIC_CODES).filter((c) => c.startsWith("T00") && !covered.has(c));
    expect(missing).toEqual([]);
  });

  it("every fixture has a golden .expected file", () => {
    const files = new Set(readdirSync(dir));
    const missing = fixtures.filter((f) => !files.has(f.replace(/\.tejun$/, ".expected")));
    expect(missing).toEqual([]);
  });
});
