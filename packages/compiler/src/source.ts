// Source files and spans.
//
// Offsets (`start`, `end`) are UTF-16 indexes into the normalized text, so
// they can be used with String.prototype.slice. Lines and columns are 1-based
// and count Unicode code points, which is what a user sees in an editor.

export interface Span {
  /** UTF-16 offset of the first character (inclusive). */
  start: number;
  /** UTF-16 offset just past the last character (exclusive). */
  end: number;
  /** 1-based line of `start`. */
  line: number;
  /** 1-based column of `start`, in code points. */
  col: number;
  /** 1-based line of `end`. */
  endLine: number;
  /** 1-based column of `end` (exclusive), in code points. */
  endCol: number;
}

export class SourceFile {
  /** Path as shown in diagnostics, always with forward slashes. */
  readonly path: string;
  /** Text with any UTF-8 BOM removed and line endings normalized to LF. */
  readonly text: string;
  private readonly lineStarts: number[];

  constructor(path: string, rawText: string) {
    this.path = path.replace(/\\/g, "/");
    const noBom = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
    this.text = noBom.replace(/\r\n?/g, "\n");
    this.lineStarts = [0];
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** Line and column (both 1-based, column in code points) of an offset. */
  position(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.lineStarts[lo]!;
    return { line: lo + 1, col: codePointLength(this.text.slice(lineStart, offset)) + 1 };
  }

  span(start: number, end: number): Span {
    const a = this.position(start);
    const b = this.position(end);
    return { start, end, line: a.line, col: a.col, endLine: b.line, endCol: b.col };
  }

  /** UTF-16 offset where a 1-based line starts. */
  lineStart(line: number): number {
    return this.lineStarts[line - 1] ?? this.text.length;
  }

  /** Text of a 1-based line, without its newline. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1];
    if (start === undefined) return "";
    const next = this.lineStarts[line];
    return this.text.slice(start, next === undefined ? this.text.length : next - 1);
  }
}

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Tabs are displayed as this many spaces in diagnostics. */
export const TAB_WIDTH = 4;

/**
 * Terminal display width: East Asian wide and full-width characters take two
 * columns, tabs take TAB_WIDTH, everything else one. Used to line up carets
 * under Japanese text.
 */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    if (ch === "\t") width += TAB_WIDTH;
    else width += isWide(ch.codePointAt(0)!) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Full-width signs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B and later
  );
}
