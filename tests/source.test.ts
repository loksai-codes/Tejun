import { describe, expect, it } from "vitest";
import { SourceFile, displayWidth, formatDiagnostic } from "@tejun/compiler";

describe("SourceFile", () => {
  it("strips a BOM and normalizes CRLF to LF", () => {
    const src = new SourceFile("a.tejun", "﻿one\r\ntwo\rthree");
    expect(src.text).toBe("one\ntwo\nthree");
    expect(src.lineCount).toBe(3);
    expect(src.lineText(2)).toBe("two");
  });

  it("shows paths with forward slashes", () => {
    expect(new SourceFile("examples\\x.tejun", "").path).toBe("examples/x.tejun");
  });

  it("counts columns in code points, not UTF-16 units or bytes", () => {
    const src = new SourceFile("a.tejun", 'a "日本🏭" b');
    const b = src.text.indexOf("b");
    expect(src.position(b)).toEqual({ line: 1, col: 9 });
  });

  it("computes spans across lines", () => {
    const src = new SourceFile("a.tejun", "ab\ncd");
    expect(src.span(1, 4)).toEqual({ start: 1, end: 4, line: 1, col: 2, endLine: 2, endCol: 2 });
  });
});

describe("displayWidth", () => {
  it("counts Japanese and full-width characters as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("ワーク検出")).toBe(10);
    expect(displayWidth("；")).toBe(2);
    expect(displayWidth("\t")).toBe(4);
  });
});

describe("formatDiagnostic", () => {
  it("lines up the caret under text that follows Japanese characters", () => {
    const src = new SourceFile("a.tejun", '  x "ワーク" $');
    const at = src.text.indexOf("$");
    const out = formatDiagnostic(
      {
        code: "T0001",
        severity: "error",
        message: "unexpected character `$`",
        messageJa: "予期しない文字 `$`",
        span: src.span(at, at + 1),
        label: "here",
      },
      src,
    );
    expect(out).toBe(
      [
        "error[T0001]: unexpected character `$`",
        " --> a.tejun:1:11",
        "  |",
        '1 |   x "ワーク" $',
        // 13 display columns before `$`: 4 ASCII + `"` + 3 wide chars (6) + `"` + space
        "  | " + " ".repeat(13) + "^ here",
        "  |",
        "  = 日本語: 予期しない文字 `$`",
      ].join("\n"),
    );
  });
});
