// Keeps the docs honest: every complete Tejun program shown in the docs must
// check clean, and the codes they mention must exist.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES, check } from "@tejun/compiler";

const root = new URL("../", import.meta.url);
const DOCS = [
  ...(existsSync(new URL("README.md", root)) ? ["README.md"] : []),
  ...readdirSync(new URL("docs/", root)).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
];
const read = (file: string) => readFileSync(new URL(file, root), "utf8");

/** ```tejun code blocks in a Markdown file. */
function tejunBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```tejun\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

describe.each(DOCS)("%s", (file) => {
  const text = read(file);

  it("every complete Tejun program checks clean", () => {
    let programs = 0;
    for (const block of tejunBlocks(text)) {
      if (!/^\s*(\/\/.*\n\s*)*station\b/.test(block)) continue; // a fragment, not a program
      programs++;
      const result = check(file, block);
      expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`), block.slice(0, 80)).toEqual([]);
    }
    if (file === "docs/language-reference.md" || file === "README.md") expect(programs).toBeGreaterThan(0);
  });

  it("mentions only diagnostic codes that exist", () => {
    const mentioned = [...new Set(text.match(/\bT0\d{3}\b/g) ?? [])];
    const unknown = mentioned.filter((c) => !(c in DIAGNOSTIC_CODES));
    expect(unknown).toEqual([]);
  });
});
