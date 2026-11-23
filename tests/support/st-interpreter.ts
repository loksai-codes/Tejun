// A small interpreter for the subset of IEC 61131-3 Structured Text that
// codegen/st.ts emits. Test-only: it lets tests/equivalence.test.ts run the
// *generated text* next to the IR interpreter and compare them scan by scan.
//
// Supported: the FUNCTION_BLOCK with VAR_INPUT / VAR_OUTPUT / VAR declarations
// (BOOL, INT, REAL, TON, optional := initial value), assignments, IF / ELSIF /
// ELSE, CASE with integer labels, TON calls with named parameters, and
// expressions with OR, AND, NOT, = <> < <= > >=, member access (.Q, .ET),
// integer, real, TRUE/FALSE and T#<n>ms literals. Identifiers are
// case-insensitive, as in ST. Anything else throws, so a generator change
// outside this subset fails loudly.

import { Ton } from "@tejun/runtime";

type Value = boolean | number;

type Token =
  | { kind: "ident"; text: string }
  | { kind: "number"; value: number }
  | { kind: "time"; ms: number }
  | { kind: "symbol"; text: string }
  | { kind: "eof" };

type Expr =
  | { kind: "literal"; value: Value }
  | { kind: "var"; name: string }
  | { kind: "member"; object: string; member: string }
  | { kind: "not"; operand: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr };

type Stmt =
  | { kind: "assign"; name: string; value: Expr }
  | { kind: "call"; name: string; args: Map<string, Expr> }
  | { kind: "if"; branches: { cond: Expr; body: Stmt[] }[]; otherwise: Stmt[] }
  | { kind: "case"; value: Expr; labels: Map<number, Stmt[]> };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (text.startsWith("(*", i)) {
      const end = text.indexOf("*)", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 2;
      continue;
    }
    const time = /^T#(\d+)ms/i.exec(text.slice(i));
    if (time) {
      tokens.push({ kind: "time", ms: Number(time[1]) });
      i += time[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?(E[+-]?\d+)?/i.exec(text.slice(i));
    if (num) {
      tokens.push({ kind: "number", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (ident) {
      tokens.push({ kind: "ident", text: ident[0].toLowerCase() });
      i += ident[0].length;
      continue;
    }
    const sym = [":=", "<=", ">=", "<>", "=", "<", ">", "(", ")", ";", ":", ",", ".", "-"].find((s) => text.startsWith(s, i));
    if (!sym) throw new Error(`unexpected character '${c}' at ${i}`);
    tokens.push({ kind: "symbol", text: sym });
    i += sym.length;
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]!;
  }
  next(): Token {
    return this.tokens[this.pos++]!;
  }
  isWord(word: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === "ident" && t.text === word;
  }
  isSym(sym: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === "symbol" && t.text === sym;
  }
  word(word: string): void {
    if (!this.isWord(word)) throw new Error(`expected ${word}, found ${JSON.stringify(this.peek())}`);
    this.pos++;
  }
  sym(sym: string): void {
    if (!this.isSym(sym)) throw new Error(`expected '${sym}', found ${JSON.stringify(this.peek())}`);
    this.pos++;
  }
  ident(): string {
    const t = this.next();
    if (t.kind !== "ident") throw new Error(`expected a name, found ${JSON.stringify(t)}`);
    return t.text;
  }

  /** Declarations: name -> { type, initial }. */
  declarations(): Map<string, { type: string; initial: Value | undefined }> {
    const vars = new Map<string, { type: string; initial: Value | undefined }>();
    while (this.isWord("var_input") || this.isWord("var_output") || this.isWord("var")) {
      this.next();
      while (!this.isWord("end_var")) {
        const name = this.ident();
        this.sym(":");
        const type = this.ident();
        let initial: Value | undefined;
        if (this.isSym(":=")) {
          this.next();
          initial = this.literal();
        }
        this.sym(";");
        vars.set(name, { type, initial });
      }
      this.word("end_var");
    }
    return vars;
  }

  private literal(): Value {
    const negative = this.isSym("-");
    if (negative) this.next();
    const t = this.next();
    if (t.kind === "number") return negative ? -t.value : t.value;
    if (t.kind === "ident" && (t.text === "true" || t.text === "false")) return t.text === "true";
    throw new Error(`expected a literal, found ${JSON.stringify(t)}`);
  }

  statements(until: (p: Parser) => boolean): Stmt[] {
    const body: Stmt[] = [];
    while (!until(this)) body.push(this.statement());
    return body;
  }

  private statement(): Stmt {
    if (this.isWord("if")) return this.ifStatement();
    if (this.isWord("case")) return this.caseStatement();
    const name = this.ident();
    if (this.isSym(":=")) {
      this.next();
      const value = this.expr();
      this.sym(";");
      return { kind: "assign", name, value };
    }
    this.sym("(");
    const args = new Map<string, Expr>();
    while (!this.isSym(")")) {
      const param = this.ident();
      this.sym(":=");
      args.set(param, this.expr());
      if (this.isSym(",")) this.next();
    }
    this.sym(")");
    this.sym(";");
    return { kind: "call", name, args };
  }

  private ifStatement(): Stmt {
    const branches: { cond: Expr; body: Stmt[] }[] = [];
    let otherwise: Stmt[] = [];
    const stop = (p: Parser) => p.isWord("elsif") || p.isWord("else") || p.isWord("end_if");
    this.word("if");
    for (;;) {
      const cond = this.expr();
      this.word("then");
      branches.push({ cond, body: this.statements(stop) });
      if (this.isWord("elsif")) {
        this.next();
        continue;
      }
      break;
    }
    if (this.isWord("else")) {
      this.next();
      otherwise = this.statements((p) => p.isWord("end_if"));
    }
    this.word("end_if");
    this.sym(";");
    return { kind: "if", branches, otherwise };
  }

  private caseStatement(): Stmt {
    this.word("case");
    const value = this.expr();
    this.word("of");
    const labels = new Map<number, Stmt[]>();
    const atLabel = (p: Parser) => p.peek().kind === "number" && p.isSym(":", 1);
    while (!this.isWord("end_case")) {
      const label = this.next();
      if (label.kind !== "number") throw new Error(`expected a case label, found ${JSON.stringify(label)}`);
      this.sym(":");
      labels.set(label.value, this.statements((p) => atLabel(p) || p.isWord("end_case")));
    }
    this.word("end_case");
    this.sym(";");
    return { kind: "case", value, labels };
  }

  // Precedence (lowest first): OR, AND, = <>, < <= > >=; NOT binds to a primary.
  expr(minBp = 0): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const op = t.kind === "ident" && (t.text === "or" || t.text === "and") ? t.text : t.kind === "symbol" ? t.text : "";
      const bp = op === "or" ? 1 : op === "and" ? 2 : op === "=" || op === "<>" ? 3 : ["<", "<=", ">", ">="].includes(op) ? 4 : 0;
      if (bp === 0 || bp <= minBp) return left;
      this.next();
      left = { kind: "binary", op, left, right: this.expr(bp) };
    }
  }

  private unary(): Expr {
    if (this.isWord("not")) {
      this.next();
      return { kind: "not", operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.next();
    if (t.kind === "number") return { kind: "literal", value: t.value };
    if (t.kind === "time") return { kind: "literal", value: t.ms };
    if (t.kind === "symbol" && t.text === "(") {
      const e = this.expr();
      this.sym(")");
      return e;
    }
    if (t.kind === "ident") {
      if (t.text === "true" || t.text === "false") return { kind: "literal", value: t.text === "true" };
      if (this.isSym(".")) {
        this.next();
        return { kind: "member", object: t.text, member: this.ident() };
      }
      return { kind: "var", name: t.text };
    }
    throw new Error(`unexpected token in expression: ${JSON.stringify(t)}`);
  }
}

/** One instance of the generated FUNCTION_BLOCK. */
export class StFunctionBlock {
  readonly name: string;
  private readonly vars = new Map<string, Value>();
  private readonly timers = new Map<string, Ton>();
  private readonly body: Stmt[];
  private now = 0;

  constructor(stSource: string) {
    const start = stSource.search(/^FUNCTION_BLOCK\b/m);
    const end = stSource.indexOf("END_FUNCTION_BLOCK");
    if (start < 0 || end < 0) throw new Error("no FUNCTION_BLOCK found");
    const p = new Parser(tokenize(stSource.slice(start, end + "END_FUNCTION_BLOCK".length)));
    p.word("function_block");
    this.name = p.ident();
    for (const [name, { type, initial }] of p.declarations()) {
      if (type === "ton") this.timers.set(name, new Ton());
      else if (type === "bool") this.vars.set(name, initial ?? false);
      else if (type === "int" || type === "real") this.vars.set(name, initial ?? 0);
      else throw new Error(`unsupported type ${type}`);
    }
    this.body = p.statements((q) => q.isWord("end_function_block"));
  }

  set(name: string, value: Value): void {
    const key = name.toLowerCase();
    if (!this.vars.has(key)) throw new Error(`unknown variable ${name}`);
    this.vars.set(key, value);
  }

  get(name: string): Value {
    const value = this.vars.get(name.toLowerCase());
    if (value === undefined) throw new Error(`unknown variable ${name}`);
    return value;
  }

  /** Run one scan at the given time. */
  call(nowMs: number): void {
    this.now = nowMs;
    this.exec(this.body);
  }

  private exec(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "assign":
          if (!this.vars.has(s.name)) throw new Error(`assignment to unknown variable ${s.name}`);
          this.vars.set(s.name, this.eval(s.value));
          break;
        case "call": {
          const timer = this.timers.get(s.name);
          if (!timer) throw new Error(`call of unknown block ${s.name}`);
          const input = this.eval(s.args.get("in") ?? { kind: "literal", value: false });
          const pt = s.args.get("pt");
          timer.call(this.now, input === true, pt ? Number(this.eval(pt)) : undefined);
          break;
        }
        case "if": {
          const branch = s.branches.find((b) => this.eval(b.cond) === true);
          this.exec(branch ? branch.body : s.otherwise);
          break;
        }
        case "case": {
          const body = s.labels.get(Number(this.eval(s.value)));
          if (body) this.exec(body);
          break;
        }
      }
    }
  }

  private eval(e: Expr): Value {
    switch (e.kind) {
      case "literal":
        return e.value;
      case "var": {
        const v = this.vars.get(e.name);
        if (v === undefined) throw new Error(`unknown variable ${e.name}`);
        return v;
      }
      case "member": {
        const timer = this.timers.get(e.object);
        if (!timer) throw new Error(`unknown block ${e.object}`);
        if (e.member === "q") return timer.q;
        if (e.member === "et") return timer.et;
        throw new Error(`unknown member ${e.object}.${e.member}`);
      }
      case "not":
        return !this.eval(e.operand);
      case "binary": {
        const l = this.eval(e.left);
        const r = this.eval(e.right);
        switch (e.op) {
          case "or":
            return l === true || r === true;
          case "and":
            return l === true && r === true;
          case "=":
            return l === r;
          case "<>":
            return l !== r;
          case "<":
            return l < r;
          case "<=":
            return l <= r;
          case ">":
            return l > r;
          case ">=":
            return l >= r;
        }
        throw new Error(`unknown operator ${e.op}`);
      }
    }
  }
}
