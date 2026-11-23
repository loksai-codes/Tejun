// Hand-written lexer. Produces tokens on demand so the parser reports the
// first error in source order, whether it is a lexical or a syntax error.
// See the lexical section of docs/grammar.ebnf.

import { DiagnosticAbort, type Diagnostic, type DiagnosticCode } from "./diagnostics.js";
import type { SourceFile, Span } from "./source.js";

export const KEYWORDS: ReadonlySet<string> = new Set([
  "station", "io", "input", "output", "bool", "real", "safety", "range", "device",
  "interlock", "never", "requires", "else", "fault", "sequence", "state",
  "on", "hold", "when", "within", "forever", "outputs", "safe", "and", "or", "not",
]);

const SYMBOLS_2 = ["..", "->", "<=", ">=", "==", "!="];
const SYMBOLS_1 = "{}():;,.@<>";

export type TokenKind = "ident" | "keyword" | "number" | "string" | "address" | "symbol" | "eof";

export interface Token {
  kind: TokenKind;
  /** Exact source text, including quotes for strings. */
  text: string;
  /** For strings, the contents without quotes; otherwise the same as `text`. */
  value: string;
  span: Span;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);
const isAddressPart = (c: string): boolean => isIdentPart(c) || c === ".";

export class Lexer {
  private readonly source: SourceFile;
  private readonly text: string;
  private pos = 0;

  constructor(source: SourceFile) {
    this.source = source;
    this.text = source.text;
  }

  /** Next token; returns an `eof` token forever at the end. Throws DiagnosticAbort. */
  next(): Token {
    this.skipTrivia();
    const text = this.text;
    const start = this.pos;
    if (start >= text.length) return this.token("eof", start, start);
    const c = text[start]!;

    if (isIdentStart(c)) {
      while (this.pos < text.length && isIdentPart(text[this.pos]!)) this.pos++;
      const word = text.slice(start, this.pos);
      return this.token(KEYWORDS.has(word) ? "keyword" : "ident", start, this.pos);
    }

    if (isDigit(c)) {
      while (isDigit(text[this.pos])) this.pos++;
      // "0..50" is NUMBER ".." NUMBER: a dot belongs to the number only before a digit.
      if (text[this.pos] === "." && isDigit(text[this.pos + 1])) {
        this.pos++;
        while (isDigit(text[this.pos])) this.pos++;
      }
      return this.token("number", start, this.pos);
    }

    if (c === '"') return this.string(start);
    if (c === "%") return this.address(start);

    const two = text.slice(start, start + 2);
    if (SYMBOLS_2.includes(two)) {
      this.pos += 2;
      return this.token("symbol", start, this.pos);
    }
    if (SYMBOLS_1.includes(c)) {
      this.pos += 1;
      return this.token("symbol", start, this.pos);
    }

    throw this.unexpectedCharacter(start);
  }

  private skipTrivia(): void {
    const text = this.text;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (c === " " || c === "\t" || c === "\n") this.pos++;
      else if (c === "/" && text[this.pos + 1] === "/") {
        while (this.pos < text.length && text[this.pos] !== "\n") this.pos++;
      } else break;
    }
  }

  private string(start: number): Token {
    const text = this.text;
    this.pos++;
    while (this.pos < text.length && text[this.pos] !== '"' && text[this.pos] !== "\n") this.pos++;
    if (text[this.pos] !== '"') {
      throw this.error("T0002", start, this.pos, {
        message: "unterminated string",
        messageJa: "文字列が閉じられていません",
        label: "this string is never closed",
        help: 'add a closing `"` before the end of the line',
      });
    }
    this.pos++;
    return { ...this.token("string", start, this.pos), value: text.slice(start + 1, this.pos - 1) };
  }

  private address(start: number): Token {
    const text = this.text;
    this.pos++;
    while (this.pos < text.length && isAddressPart(text[this.pos]!)) this.pos++;
    const addr = text.slice(start, this.pos);
    const help = addressProblem(addr);
    if (help !== undefined) {
      throw this.error("T0003", start, this.pos, {
        message: `malformed I/O address \`${addr}\``,
        messageJa: `不正なI/Oアドレス \`${addr}\``,
        label: "not a valid address",
        help,
      });
    }
    return this.token("address", start, this.pos);
  }

  private unexpectedCharacter(start: number): DiagnosticAbort {
    const ch = String.fromCodePoint(this.text.codePointAt(start)!);
    const cp = ch.codePointAt(0)!;
    let help: string | undefined;
    if (cp >= 0xff01 && cp <= 0xff5e) {
      const ascii = String.fromCodePoint(cp - 0xfee0);
      help = `this is a full-width \`${ch}\`; use the ASCII \`${ascii}\``;
    } else if (cp > 0x7f) {
      help = 'Japanese and other non-ASCII text is allowed only inside "strings" and // comments';
    } else if (ch === "=") {
      help = "use `==` to compare";
    } else if (ch === "!") {
      help = "use `not` to negate, or `!=` for not-equal";
    } else if (ch === "/") {
      help = "comments start with `//`";
    }
    return this.error("T0001", start, start + ch.length, {
      message: `unexpected character \`${ch}\``,
      messageJa: `予期しない文字 \`${ch}\``,
      label: "not allowed here",
      ...(help ? { help } : {}),
    });
  }

  private token(kind: TokenKind, start: number, end: number): Token {
    const text = this.text.slice(start, end);
    return { kind, text, value: text, span: this.source.span(start, end) };
  }

  private error(
    code: DiagnosticCode,
    start: number,
    end: number,
    parts: Pick<Diagnostic, "message" | "messageJa" | "label" | "help">,
  ): DiagnosticAbort {
    return new DiagnosticAbort({ code, severity: "error", span: this.source.span(start, end), ...parts });
  }
}

/** Returns a help line if the address is malformed, otherwise undefined. */
function addressProblem(addr: string): string | undefined {
  const generic = "addresses look like %IX0.0 (input bit), %QX0.1 (output bit) or %IW2 (input word)";
  const area = addr[1];
  const size = addr[2];
  const rest = addr.slice(3);
  if (area === "M") return "memory addresses (%M) are not supported; use %I for inputs and %Q for outputs";
  if (area !== "I" && area !== "Q") return generic;
  if (size === "W") return /^\d+$/.test(rest) ? undefined : `word addresses look like %${area}W2`;
  if (size !== "X") return generic;
  if (/^\d+$/.test(rest)) return `a bit address needs a byte and a bit number, like %${area}X0.1`;
  const m = /^(\d+)\.(\d+)$/.exec(rest);
  if (!m) return generic;
  const bit = Number(m[2]);
  if (bit > 7) {
    const byte = Number(m[1]) + Math.floor(bit / 8);
    return `the bit number must be 0..7; did you mean %${area}X${byte}.${bit % 8}?`;
  }
  return undefined;
}

/** Lex a whole file. Throws DiagnosticAbort on the first error. */
export function lexAll(source: SourceFile): Token[] {
  const lexer = new Lexer(source);
  const tokens: Token[] = [];
  for (;;) {
    const t = lexer.next();
    tokens.push(t);
    if (t.kind === "eof") return tokens;
  }
}
