// Golden tests for generated Structured Text, plus structural checks that
// hold for every example. Regenerate goldens on purpose with UPDATE_GOLDEN=1
// (see tests/diagnostics.test.ts for the PowerShell form).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { build } from "@tejun/compiler";

const examplesDir = new URL("../examples/", import.meta.url);
const goldenDir = new URL("./golden/", import.meta.url);
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".tejun"));
const update = process.env.UPDATE_GOLDEN === "1";

function stOf(file: string): string {
  const result = build(`examples/${file}`, readFileSync(new URL(file, examplesDir), "utf8"));
  expect(result.diagnostics).toEqual([]);
  return result.st!;
}

/** The FUNCTION_BLOCK body with comments removed. */
function functionBlockCode(st: string): string {
  const fb = st.slice(st.indexOf("FUNCTION_BLOCK"), st.indexOf("END_FUNCTION_BLOCK"));
  return fb.replace(/\(\*[\s\S]*?\*\)/g, "");
}

describe("Structured Text golden files", () => {
  it.each(examples)("%s", (file) => {
    const actual = stOf(file);
    const goldenUrl = new URL(file.replace(/\.tejun$/, ".st"), goldenDir);
    if (update) writeFileSync(goldenUrl, actual, "utf8");
    expect(actual).toBe(readFileSync(goldenUrl, "utf8").replace(/\r\n/g, "\n"));
  });
});

describe("Structured Text structure", () => {
  it.each(examples)("%s: every output is assigned exactly once in the block (no double coils)", (file) => {
    const st = stOf(file);
    const code = functionBlockCode(st);
    const outputs = [...st.matchAll(/^\s+(\w+) AT %Q\w[\d.]+ : BOOL;/gm)].map((m) => m[1]!);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      const assignments = code.match(new RegExp(String.raw`^\s*${output} :=`, "gm")) ?? [];
      expect(assignments, output).toHaveLength(1);
    }
  });

  it.each(examples)("%s: code outside comments is ASCII", (file) => {
    const code = stOf(file).replace(/\(\*[\s\S]*?\*\)/g, "");
    expect(code).toMatch(/^[\x00-\x7f]*$/);
  });

  it.each(examples)("%s: blocks are balanced", (file) => {
    const code = stOf(file).replace(/\(\*[\s\S]*?\*\)/g, "");
    const count = (re: RegExp) => (code.match(re) ?? []).length;
    // \b does not match between `_` and a letter, so END_IF is not counted as IF.
    expect(count(/\bIF\b/g)).toBe(count(/\bEND_IF\b/g));
    expect(count(/\bCASE\b/g)).toBe(count(/\bEND_CASE\b/g));
    expect(count(/\bVAR(_INPUT|_OUTPUT)?\b/g)).toBe(count(/\bEND_VAR\b/g));
    expect(count(/\bFUNCTION_BLOCK\b/g)).toBe(count(/\bEND_FUNCTION_BLOCK\b/g));
  });

  it("is not generated when the program has errors", () => {
    const text = readFileSync(new URL("press_feeder.tejun", examplesDir), "utf8");
    const result = build("x.tejun", text.replace(/^\s*state Home.*\n/m, ""));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["T0203"]);
    expect(result.st).toBeUndefined();
  });

  it("keeps Japanese labels as comments", () => {
    expect(stOf("press_feeder.tejun")).toContain("(* ワーク検出, %IX0.0 *)");
  });
});
