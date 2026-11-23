// Hand-written recursive-descent parser with Pratt parsing for expressions.
// Follows docs/grammar.ebnf and stops at the first syntax error.

import type * as A from "./ast.js";
import { DiagnosticAbort, type Diagnostic, type DiagnosticCode } from "./diagnostics.js";
import { Lexer, type Token } from "./lexer.js";
import type { SourceFile, Span } from "./source.js";

/** A phrase for messages, in English and Japanese. */
interface Phrase {
  en: string;
  ja: string;
}

const tok = (text: string): Phrase => ({ en: `\`${text}\``, ja: `\`${text}\`` });
const phrase = (en: string, ja: string): Phrase => ({ en, ja });

const SECTION_ORDER = ["io", "device", "interlock", "sequence", "on"] as const;
type Section = (typeof SECTION_ORDER)[number];
const SECTION_HELP = "sections go in this order: io, device, interlock, sequence, on";

const STATEMENT_HELP =
  "a statement is one of: `<output> on`, `<device>.<action> within …`, `hold <time>`, `when <cond> … -> <State>`, `-> <State>`";
const HANDLER_HELP = "a handler body is `outputs safe; -> Stopped`";
const INTERLOCK_HELP =
  "an interlock is `never <cond>`, `<output> requires <cond>`, or `<cond> else fault <CODE>`";

/** Keywords that a mistyped word inside a state is most likely meant to be. */
const STATEMENT_KEYWORDS = ["when", "hold", "within", "forever", "on"];

const COMPARE_OPS: ReadonlySet<string> = new Set(["<", "<=", ">", ">=", "==", "!="]);

// Pratt binding powers: [left, right]. Comparisons are non-associative.
const BP_OR: [number, number] = [1, 2];
const BP_AND: [number, number] = [3, 4];
const BP_NOT_OPERAND = 5;
const BP_COMPARE: [number, number] = [7, 8];

interface FailOptions {
  help?: string;
  /** Keywords the found word may be a typo of (for "did you mean"). */
  keywords?: readonly string[];
  /** Report any identifier here as an unknown keyword, even without a close match. */
  keywordOnly?: boolean;
}

export class Parser {
  private readonly source: SourceFile;
  private readonly lexer: Lexer;
  private readonly buffer: Token[] = [];
  private last: Token | undefined;
  /** Opening braces not yet closed, innermost last. */
  private readonly braces: Token[] = [];
  /** Expressions that were written in parentheses (chained-comparison check). */
  private readonly parenthesized = new WeakSet<A.Expr>();

  constructor(source: SourceFile) {
    this.source = source;
    this.lexer = new Lexer(source);
  }

  // ===== Program structure =====

  parseProgram(): A.Program {
    const station = this.parseStation();
    if (this.peek().kind !== "eof") {
      this.fail([phrase("end of file", "ファイルの終わり")], {
        help: "a file contains exactly one station",
      });
    }
    return { kind: "Program", station, span: station.span };
  }

  private parseStation(): A.Station {
    const start = this.expectKeyword("station", { keywordOnly: true });
    const name = this.expectIdent(phrase("a station name", "ステーション名"));
    const label = this.peek().kind === "string" ? this.parseString() : undefined;
    this.expectSymbol("{");

    let io: A.IoBlock | undefined;
    const devices: A.DeviceDecl[] = [];
    const interlocks: A.Interlock[] = [];
    let sequence: A.Sequence | undefined;
    const handlers: A.Handler[] = [];
    let current: Section | undefined;

    while (!this.isSymbol("}")) {
      const t = this.peek();
      const section = SECTION_ORDER.find((s) => t.kind === "keyword" && t.text === s);
      if (section === undefined) {
        this.fail([...SECTION_ORDER.map(tok), tok("}")], {
          keywords: SECTION_ORDER,
          keywordOnly: true,
        });
      }
      this.checkSectionOrder(t, section, current, io !== undefined, sequence !== undefined);
      current = section;

      switch (section) {
        case "io":
          io = this.parseIo();
          break;
        case "device":
          devices.push(this.parseDevice());
          break;
        case "interlock":
          interlocks.push(this.parseInterlock());
          break;
        case "sequence":
          sequence = this.parseSequence();
          break;
        case "on":
          handlers.push(this.parseHandler());
          break;
      }
    }

    if (io === undefined) {
      this.fail([tok("io")], { help: "every station starts with an `io` block" });
    }
    if (sequence === undefined) {
      this.fail([tok("sequence"), tok("on")], { help: "every station needs exactly one `sequence`" });
    }
    const end = this.expectSymbol("}");
    return {
      kind: "Station",
      name,
      label,
      io,
      devices,
      interlocks,
      sequence,
      handlers,
      span: this.spanFrom(start.span, end.span),
    };
  }

  private checkSectionOrder(
    t: Token,
    section: Section,
    current: Section | undefined,
    haveIo: boolean,
    haveSequence: boolean,
  ): void {
    if ((section === "io" && haveIo) || (section === "sequence" && haveSequence)) {
      const what = section === "io" ? "`io` block" : "`sequence`";
      const whatJa = section === "io" ? "`io` ブロック" : "`sequence`";
      throw this.abort("T0014", t.span, {
        message: `a station can have only one ${what}`,
        messageJa: `${whatJa} は1つだけ書けます`,
        label: "second one here",
        help: `merge them into one ${what}`,
      });
    }
    if (section !== "io" && !haveIo) {
      throw this.abort("T0014", t.span, {
        message: `the \`io\` block must come before \`${section}\``,
        messageJa: `\`io\` ブロックは \`${section}\` より前に書く必要があります`,
        label: "found before `io`",
        help: SECTION_HELP,
      });
    }
    if (current !== undefined && SECTION_ORDER.indexOf(section) < SECTION_ORDER.indexOf(current)) {
      throw this.abort("T0014", t.span, {
        message: `\`${section}\` must come before \`${current}\``,
        messageJa: `\`${section}\` は \`${current}\` より前に書く必要があります`,
        label: "out of order",
        help: SECTION_HELP,
      });
    }
  }

  // ===== I/O =====

  private parseIo(): A.IoBlock {
    const start = this.expectKeyword("io");
    this.expectSymbol("{");
    const decls: A.IoDecl[] = [];
    while (!this.isSymbol("}")) decls.push(this.parseIoDecl());
    const end = this.expectSymbol("}");
    return { kind: "IoBlock", decls, span: this.spanFrom(start.span, end.span) };
  }

  private parseIoDecl(): A.IoDecl {
    const t = this.peek();
    if (!this.isKeyword("input") && !this.isKeyword("output")) {
      this.fail([tok("input"), tok("output"), tok("}")], {
        keywords: ["input", "output"],
        keywordOnly: true,
      });
    }
    this.next();
    const direction = t.text as "input" | "output";
    const name = this.expectIdent(phrase("a signal name", "信号名"));
    this.expectSymbol(":");
    const type = this.parseType();
    this.expectSymbol("@");
    const address = this.parseAddress();
    const label = this.peek().kind === "string" ? this.parseString() : undefined;
    const safety = this.isKeyword("safety") ? this.next().span : undefined;
    const range = this.isKeyword("range") ? this.parseRange() : undefined;
    return {
      kind: "IoDecl",
      direction,
      name,
      type,
      address,
      label,
      safety,
      range,
      span: this.spanFrom(t.span, this.lastSpan()),
    };
  }

  private parseType(): A.TypeRef {
    if (this.isKeyword("bool")) {
      return { kind: "BoolType", span: this.next().span };
    }
    if (this.isKeyword("real")) {
      const start = this.next();
      let unit: A.Ident | undefined;
      if (this.isSymbol("<")) {
        this.next();
        unit = this.expectIdent(phrase("a unit such as `kN`", "`kN` などの単位"));
        this.expectSymbol(">");
      }
      return { kind: "RealType", unit, span: this.spanFrom(start.span, this.lastSpan()) };
    }
    return this.fail([phrase("a type (`bool` or `real`)", "型 (`bool` または `real`)")], {
      keywords: ["bool", "real"],
    });
  }

  private parseAddress(): A.Address {
    const t = this.peek();
    if (t.kind !== "address") {
      return this.fail([phrase("an I/O address such as `%IX0.0`", "`%IX0.0` のようなI/Oアドレス")]);
    }
    this.next();
    // The lexer has already validated the shape: %[IQ](X<byte>.<bit>|W<word>).
    const area = t.text[1] as "I" | "Q";
    const size = t.text[2] as "X" | "W";
    const [byte, bit] = t.text.slice(3).split(".");
    return {
      kind: "Address",
      text: t.text,
      area,
      size,
      byte: Number(byte),
      bit: bit === undefined ? undefined : Number(bit),
      span: t.span,
    };
  }

  private parseRange(): A.RangeSpec {
    const start = this.expectKeyword("range");
    const min = this.expectNumber();
    this.expectSymbol("..");
    const max = this.expectNumber();
    return { kind: "Range", min, max, span: this.spanFrom(start.span, max.span) };
  }

  // ===== Devices =====

  private parseDevice(): A.DeviceDecl {
    const start = this.expectKeyword("device");
    const name = this.expectIdent(phrase("a device name", "デバイス名"));
    this.expectSymbol(":");
    const deviceKind = this.expectIdent(phrase("a device kind such as `Cylinder`", "`Cylinder` などのデバイス種別"));
    this.expectSymbol("(");
    const args: A.DeviceArg[] = [this.parseDeviceArg()];
    while (this.isSymbol(",")) {
      this.next();
      args.push(this.parseDeviceArg());
    }
    const end = this.expectSymbol(")");
    return { kind: "DeviceDecl", name, deviceKind, args, span: this.spanFrom(start.span, end.span) };
  }

  private parseDeviceArg(): A.DeviceArg {
    const param = this.expectIdent(phrase("a parameter name such as `extend`", "`extend` などのパラメータ名"));
    this.expectSymbol(":");
    const signal = this.expectIdent(phrase("a signal name", "信号名"));
    return { kind: "DeviceArg", param, signal, span: this.spanFrom(param.span, signal.span) };
  }

  // ===== Interlocks =====

  private parseInterlock(): A.Interlock {
    const start = this.expectKeyword("interlock");
    if (this.isKeyword("never")) {
      this.next();
      const condition = this.parseExpr();
      return { kind: "NeverInterlock", condition, span: this.spanFrom(start.span, condition.span) };
    }
    if (this.peek().kind === "ident" && this.isKeyword("requires", 1)) {
      const output = this.expectIdent(phrase("an output name", "出力名"));
      this.next();
      const condition = this.parseExpr();
      return {
        kind: "RequiresInterlock",
        output,
        condition,
        span: this.spanFrom(start.span, condition.span),
      };
    }
    const condition = this.parseExpr();
    this.expectKeyword("else", { help: INTERLOCK_HELP });
    this.expectKeyword("fault", { help: INTERLOCK_HELP });
    const fault = this.expectIdent(phrase("a fault code such as `OVERLOAD`", "`OVERLOAD` などの故障コード"));
    return { kind: "ConditionInterlock", condition, fault, span: this.spanFrom(start.span, fault.span) };
  }

  // ===== Sequence and states =====

  private parseSequence(): A.Sequence {
    const start = this.expectKeyword("sequence");
    const name = this.expectIdent(phrase("a sequence name", "シーケンス名"));
    this.expectSymbol("{");
    const states: A.State[] = [];
    while (!this.isSymbol("}") || states.length === 0) {
      if (!this.isKeyword("state")) {
        this.fail(states.length === 0 ? [tok("state")] : [tok("state"), tok("}")], {
          keywords: ["state"],
          keywordOnly: true,
          ...(states.length === 0 ? { help: "a sequence needs at least one state" } : {}),
        });
      }
      states.push(this.parseState());
    }
    const end = this.expectSymbol("}");
    return { kind: "Sequence", name, states, span: this.spanFrom(start.span, end.span) };
  }

  private parseState(): A.State {
    const start = this.expectKeyword("state");
    const name = this.expectIdent(phrase("a state name", "状態名"));
    this.expectSymbol("{");
    const statements: A.Statement[] = [];
    if (!this.isSymbol("}")) {
      for (;;) {
        statements.push(this.parseStatement());
        if (this.isSymbol(";")) {
          this.next();
          if (this.isSymbol("}")) break;
          continue;
        }
        if (this.isSymbol("}")) break;
        this.failAfterStatement(name);
      }
    }
    const end = this.expectSymbol("}");
    return { kind: "State", name, statements, span: this.spanFrom(start.span, end.span) };
  }

  /** A statement ended but the next token is neither `;` nor `}`. */
  private failAfterStatement(stateName: A.Ident): never {
    const t = this.peek();
    if (t.kind === "ident") {
      const suggestion = closestKeyword(t.text, STATEMENT_KEYWORDS);
      if (suggestion) throw this.unknownKeyword(t, suggestion);
    }
    const startsStatement =
      t.kind === "ident" || this.isKeyword("when") || this.isKeyword("hold") || this.isSymbol("->");
    if (startsStatement) {
      const at = this.lastSpan().end;
      throw this.abort("T0016", this.source.span(at, at), {
        message: "missing `;` between statements",
        messageJa: "文の間に `;` がありません",
        label: "expected `;` here",
        help: "separate statements in a state with `;`",
      });
    }
    if (this.isKeyword("state")) {
      return this.fail([tok(";"), tok("}")], {
        help: `did you forget the \`}\` that closes state \`${stateName.name}\`?`,
      });
    }
    return this.fail([tok(";"), tok("}")]);
  }

  private parseStatement(): A.Statement {
    const t = this.peek();
    if (this.isKeyword("when")) return this.parseWhen();
    if (this.isKeyword("hold")) {
      this.next();
      const duration = this.parseDuration();
      return { kind: "Hold", duration, span: this.spanFrom(t.span, duration.span) };
    }
    if (this.isSymbol("->")) return this.parseGoto();
    if (t.kind === "ident") {
      if (this.isKeyword("on", 1)) {
        const output = this.expectIdent(phrase("an output name", "出力名"));
        const on = this.next();
        return { kind: "OutputOn", output, span: this.spanFrom(output.span, on.span) };
      }
      if (this.isSymbol(".", 1)) {
        const device = this.expectIdent(phrase("a device name", "デバイス名"));
        this.next();
        const action = this.expectIdent(phrase("an action such as `extend`", "`extend` などの動作"));
        const timeout = this.parseTimeout();
        return {
          kind: "DeviceAction",
          device,
          action,
          timeout,
          span: this.spanFrom(device.span, this.lastSpan()),
        };
      }
      const suggestion = closestKeyword(t.text, ["when", "hold"]);
      if (suggestion) throw this.unknownKeyword(t, suggestion);
      this.next();
      return this.fail([tok("on"), tok(".")], { help: STATEMENT_HELP });
    }
    return this.fail([phrase("a statement", "文")], {
      help: STATEMENT_HELP,
      keywords: ["when", "hold"],
    });
  }

  private parseWhen(): A.When {
    const start = this.expectKeyword("when");
    const condition = this.parseExpr();
    const timeout = this.parseTimeout();
    if (!this.isSymbol("->")) {
      this.fail(timeout ? [tok("->")] : [tok("->"), tok("within"), tok("forever")], {
        keywords: timeout ? [] : ["within", "forever"],
      });
    }
    this.next();
    const target = this.expectIdent(phrase("a state name", "状態名"));
    return { kind: "When", condition, timeout, target, span: this.spanFrom(start.span, target.span) };
  }

  private parseGoto(): A.Goto {
    const start = this.expectSymbol("->");
    const target = this.expectIdent(phrase("a state name", "状態名"));
    return { kind: "Goto", target, span: this.spanFrom(start.span, target.span) };
  }

  private parseTimeout(): A.Timeout | undefined {
    if (this.isKeyword("forever")) return { kind: "ForeverTimeout", span: this.next().span };
    if (!this.isKeyword("within")) return undefined;
    const start = this.next();
    const duration = this.parseDuration();
    this.expectKeyword("else", { help: "a timeout is `within <time> else fault <CODE>`" });
    this.expectKeyword("fault", { help: "a timeout is `within <time> else fault <CODE>`" });
    const fault = this.expectIdent(phrase("a fault code such as `CLAMP_TIMEOUT`", "`CLAMP_TIMEOUT` などの故障コード"));
    return { kind: "WithinTimeout", duration, fault, span: this.spanFrom(start.span, fault.span) };
  }

  private parseDuration(): A.Duration {
    const value = this.expectNumber();
    if (this.peek().kind !== "ident") {
      this.fail([phrase("a time unit (`ms` or `s`)", "時間単位 (`ms` または `s`)")]);
    }
    const unit = this.expectIdent(phrase("a time unit", "時間単位"));
    return { kind: "Duration", value, unit, span: this.spanFrom(value.span, unit.span) };
  }

  // ===== Handlers =====

  private parseHandler(): A.Handler {
    const start = this.expectKeyword("on");
    const trigger: A.FaultTrigger | A.Expr = this.isKeyword("fault")
      ? { kind: "FaultTrigger", span: this.next().span }
      : this.parseExpr();
    this.expectSymbol("{");
    this.expectKeyword("outputs", { help: HANDLER_HELP });
    this.expectKeyword("safe", { help: HANDLER_HELP });
    this.expectSymbol(";", { help: HANDLER_HELP });
    this.expectSymbol("->", { help: HANDLER_HELP });
    const target = this.expectIdent(phrase("a state name", "状態名"));
    if (this.isSymbol(";")) this.next();
    const end = this.expectSymbol("}", { help: HANDLER_HELP });
    return { kind: "Handler", trigger, target, span: this.spanFrom(start.span, end.span) };
  }

  // ===== Expressions (Pratt) =====

  private parseExpr(minBp = 0): A.Expr {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      const isCompare = t.kind === "symbol" && COMPARE_OPS.has(t.text);
      const bp = isCompare ? BP_COMPARE : this.isKeyword("and") ? BP_AND : this.isKeyword("or") ? BP_OR : undefined;
      if (bp === undefined || bp[0] < minBp) return left;
      this.next();
      const right = this.parseExpr(bp[1]);
      const span = this.spanFrom(left.span, right.span);
      if (isCompare) {
        if (left.kind === "CompareExpr" && !this.parenthesized.has(left)) {
          throw this.abort("T0015", span, {
            message: "comparisons cannot be chained",
            messageJa: "比較演算子は連結できません",
            label: "chained comparison",
            help: "compare each pair and join them with `and`, e.g. `0 < x and x < 40`",
          });
        }
        left = { kind: "CompareExpr", op: t.text as A.CompareOp, left, right, span };
      } else {
        left = { kind: "LogicalExpr", op: t.text as "and" | "or", left, right, span };
      }
    }
  }

  private parsePrefix(): A.Expr {
    const t = this.peek();
    if (this.isKeyword("not")) {
      this.next();
      const operand = this.parseExpr(BP_NOT_OPERAND);
      return { kind: "NotExpr", operand, span: this.spanFrom(t.span, operand.span) };
    }
    if (this.isSymbol("(")) {
      this.next();
      const inner = this.parseExpr();
      const close = this.expectSymbol(")");
      const expr = { ...inner, span: this.spanFrom(t.span, close.span) };
      this.parenthesized.add(expr);
      return expr;
    }
    if (t.kind === "number") {
      const value = this.expectNumber();
      const unit = this.peek().kind === "ident" ? this.expectIdent(phrase("a unit", "単位")) : undefined;
      return { kind: "Quantity", value, unit, span: this.spanFrom(value.span, this.lastSpan()) };
    }
    if (t.kind === "ident") {
      const name = this.expectIdent(phrase("a name", "名前"));
      if (!this.isSymbol(".")) return { kind: "NameRef", name, span: name.span };
      this.next();
      const member = this.expectIdent(phrase("a device state such as `retracted`", "`retracted` などのデバイス状態"));
      return { kind: "MemberRef", object: name, member, span: this.spanFrom(name.span, member.span) };
    }
    return this.fail([phrase("a condition", "条件")]);
  }

  // ===== Token helpers =====

  private peek(k = 0): Token {
    while (this.buffer.length <= k) {
      const last = this.buffer[this.buffer.length - 1];
      if (last?.kind === "eof") return last;
      this.buffer.push(this.lexer.next());
    }
    return this.buffer[k]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.buffer.shift();
    this.last = t;
    return t;
  }

  private lastSpan(): Span {
    return this.last?.span ?? this.peek().span;
  }

  private isKeyword(word: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === "keyword" && t.text === word;
  }

  private isSymbol(symbol: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === "symbol" && t.text === symbol;
  }

  private expectKeyword(word: string, options: FailOptions = {}): Token {
    if (!this.isKeyword(word)) this.fail([tok(word)], { keywords: [word], ...options });
    return this.next();
  }

  private expectSymbol(symbol: string, options: FailOptions = {}): Token {
    if (!this.isSymbol(symbol)) this.fail([tok(symbol)], options);
    const t = this.next();
    if (symbol === "{") this.braces.push(t);
    if (symbol === "}") this.braces.pop();
    return t;
  }

  private expectIdent(what: Phrase): A.Ident {
    const t = this.peek();
    if (t.kind === "keyword") {
      throw this.abort("T0013", t.span, {
        message: `\`${t.text}\` is a keyword and cannot be used as a name`,
        messageJa: `\`${t.text}\` はキーワードのため名前として使えません`,
        label: `expected ${what.en}`,
        help: `choose another name, such as \`${t.text}_1\``,
      });
    }
    if (t.kind !== "ident") this.fail([what]);
    this.next();
    return { kind: "Ident", name: t.text, span: t.span };
  }

  private expectNumber(): A.NumberLit {
    const t = this.peek();
    if (t.kind !== "number") this.fail([phrase("a number", "数値")]);
    this.next();
    return { kind: "NumberLit", value: Number(t.text), text: t.text, span: t.span };
  }

  private parseString(): A.StringLit {
    const t = this.next();
    return { kind: "StringLit", value: t.value, span: t.span };
  }

  private spanFrom(start: Span, end: Span): Span {
    return this.source.span(start.start, end.end);
  }

  // ===== Errors =====

  /** Report that the current token is not one of `expected`. */
  private fail(expected: readonly Phrase[], options: FailOptions = {}): never {
    const t = this.peek();

    if (t.kind === "eof" && this.braces.length > 0) {
      const open = this.braces[this.braces.length - 1]!;
      throw this.abort("T0011", open.span, {
        message: "unexpected end of file: `{` is never closed",
        messageJa: "ファイルが途中で終わっています: `{` が閉じられていません",
        label: "this `{` is never closed",
        help: "add the matching `}`",
      });
    }

    if (t.kind === "ident" && options.keywords) {
      const suggestion = closestKeyword(t.text, options.keywords);
      if (suggestion || options.keywordOnly) throw this.unknownKeyword(t, suggestion, expected);
    }

    const list = joinPhrases(expected);
    const found = describe(t);
    throw this.abort("T0010", t.span, {
      message: `expected ${list.en}, found ${found.en}`,
      messageJa: `${list.ja} が必要ですが、${found.ja} が見つかりました`,
      label: `expected ${list.en}`,
      ...(options.help ? { help: options.help } : {}),
    });
  }

  private unknownKeyword(t: Token, suggestion: string | undefined, expected?: readonly Phrase[]): DiagnosticAbort {
    return this.abort("T0012", t.span, {
      message: `unknown keyword \`${t.text}\``,
      messageJa: `不明なキーワード \`${t.text}\``,
      label: "unknown keyword",
      help: suggestion
        ? `did you mean \`${suggestion}\`?`
        : `expected ${joinPhrases(expected ?? []).en}`,
    });
  }

  private abort(
    code: DiagnosticCode,
    span: Span,
    parts: Pick<Diagnostic, "message" | "messageJa" | "label" | "help">,
  ): DiagnosticAbort {
    return new DiagnosticAbort({ code, severity: "error", span, ...parts });
  }
}

function describe(t: Token): Phrase {
  switch (t.kind) {
    case "keyword":
      return phrase(`keyword \`${t.text}\``, `キーワード \`${t.text}\``);
    case "ident":
      return phrase(`name \`${t.text}\``, `名前 \`${t.text}\``);
    case "number":
      return phrase(`number \`${t.text}\``, `数値 \`${t.text}\``);
    case "string":
      return phrase("a string", "文字列");
    case "address":
      return phrase(`address \`${t.text}\``, `アドレス \`${t.text}\``);
    case "symbol":
      return tok(t.text);
    case "eof":
      return phrase("end of file", "ファイルの終わり");
  }
}

function joinPhrases(items: readonly Phrase[]): Phrase {
  const en = items.map((p) => p.en);
  const ja = items.map((p) => p.ja);
  if (en.length <= 1) return phrase(en[0] ?? "", ja[0] ?? "");
  return phrase(
    `${en.slice(0, -1).join(", ")} or ${en[en.length - 1]}`,
    `${ja.slice(0, -1).join("、")} または ${ja[ja.length - 1]}`,
  );
}

/** The closest keyword within a small edit distance, for "did you mean". */
function closestKeyword(word: string, candidates: readonly string[]): string | undefined {
  const limit = word.length <= 3 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d > 0 && d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[b.length]!;
}
