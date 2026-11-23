import { describe, expect, it } from "vitest";
import { SourceFile, tokenize } from "@tejun/compiler";

const kinds = (text: string) => {
  const result = tokenize(new SourceFile("t.tejun", text));
  expect(result.diagnostics).toEqual([]);
  return result.tokens.map((t) => [t.kind, t.value]);
};

const errorOf = (text: string) => {
  const result = tokenize(new SourceFile("t.tejun", text));
  expect(result.diagnostics).toHaveLength(1);
  return result.diagnostics[0]!;
};

describe("lexer", () => {
  it("separates keywords from identifiers", () => {
    expect(kinds("state Idle when part_present")).toEqual([
      ["keyword", "state"],
      ["ident", "Idle"],
      ["keyword", "when"],
      ["ident", "part_present"],
      ["eof", ""],
    ]);
  });

  it("lexes bit and word addresses", () => {
    expect(kinds("%IX0.0 %QX12.7 %IW2")).toEqual([
      ["address", "%IX0.0"],
      ["address", "%QX12.7"],
      ["address", "%IW2"],
      ["eof", ""],
    ]);
  });

  it("lexes 0..50 as number, range symbol, number", () => {
    expect(kinds("0..50 1.5")).toEqual([
      ["number", "0"],
      ["symbol", ".."],
      ["number", "50"],
      ["number", "1.5"],
      ["eof", ""],
    ]);
  });

  it("keeps Japanese text in strings and drops comments", () => {
    expect(kinds('"ワーク検出" // コメント\n->')).toEqual([
      ["string", "ワーク検出"],
      ["symbol", "->"],
      ["eof", ""],
    ]);
  });

  it("prefers two-character symbols", () => {
    expect(kinds("<= < >= != == -> .")).toEqual([
      ["symbol", "<="],
      ["symbol", "<"],
      ["symbol", ">="],
      ["symbol", "!="],
      ["symbol", "=="],
      ["symbol", "->"],
      ["symbol", "."],
      ["eof", ""],
    ]);
  });

  it("gives spans on the right line after CRLF line endings", () => {
    const { tokens } = tokenize(new SourceFile("t.tejun", "io {\r\n  input\r\n}"));
    expect(tokens[2]!.span).toMatchObject({ line: 2, col: 3, endLine: 2, endCol: 8 });
  });

  it("reports an unterminated string up to the end of the line", () => {
    const d = errorOf('a "ワーク\nb');
    expect(d.code).toBe("T0002");
    expect(d.span).toMatchObject({ line: 1, col: 3, endLine: 1, endCol: 7 });
  });

  it.each([
    ["%QX9", "byte and a bit number"],
    ["%QX0.8", "did you mean %QX1.0?"],
    ["%MX0.0", "memory addresses"],
    ["%IW", "word addresses"],
    ["%", "addresses look like"],
  ])("rejects the address %s", (addr, help) => {
    const d = errorOf(`x @ ${addr} y`);
    expect(d.code).toBe("T0003");
    expect(d.help).toContain(help);
  });

  it.each([
    ["；", "full-width"],
    ["検出", "non-ASCII"],
    ["=", "`==`"],
    ["!", "`not`"],
    ["/", "`//`"],
    ["$", undefined],
  ])("rejects the character %s", (ch, help) => {
    const d = errorOf(`a ${ch}`);
    expect(d.code).toBe("T0001");
    if (help) expect(d.help).toContain(help);
    else expect(d.help).toBeUndefined();
  });
});
