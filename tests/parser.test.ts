import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceFile, parse, type AST, type Span } from "@tejun/compiler";

const examplesDir = new URL("../examples/", import.meta.url);
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".tejun"));

function parseOk(path: string, text: string): AST.Program {
  const result = parse(new SourceFile(path, text));
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}

function parseExample(file: string): { program: AST.Program; text: string } {
  const text = readFileSync(new URL(file, examplesDir), "utf8");
  return { program: parseOk(`examples/${file}`, text), text };
}

/** A minimal station around one interlock expression. */
function parseInterlockExpr(expr: string): AST.Expr {
  const program = parseOk(
    "t.tejun",
    `station T {
       io { input a : bool @ %IX0.0 }
       interlock never ${expr}
       sequence main { state S { when a forever -> S } }
     }`,
  );
  const interlock = program.station.interlocks[0]!;
  expect(interlock.kind).toBe("NeverInterlock");
  return (interlock as AST.NeverInterlock).condition;
}

/** Render an expression tree compactly to check precedence. */
function show(e: AST.Expr): string {
  switch (e.kind) {
    case "LogicalExpr":
    case "CompareExpr":
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case "NotExpr":
      return `(not ${show(e.operand)})`;
    case "NameRef":
      return e.name.name;
    case "MemberRef":
      return `${e.object.name}.${e.member.name}`;
    case "Quantity":
      return e.unit ? `${e.value.text}${e.unit.name}` : e.value.text;
  }
}

/** Visit every node that has a span, with its parent's span. */
function walkSpans(node: unknown, parent: Span | undefined, visit: (span: Span, parent: Span | undefined) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkSpans(child, parent, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const span = isSpan(obj.span) ? obj.span : undefined;
  if (span) visit(span, parent);
  for (const [key, value] of Object.entries(obj)) {
    if (key !== "span") walkSpans(value, span ?? parent, visit);
  }
}

function isSpan(v: unknown): v is Span {
  return typeof v === "object" && v !== null && "start" in v && "end" in v && "line" in v;
}

describe("parser: examples", () => {
  it.each(examples)("%s parses without errors", (file) => {
    const { program } = parseExample(file);
    expect(program.station.sequence.states.length).toBeGreaterThan(0);
  });

  it.each(examples)("%s: every span is inside its parent and the file", (file) => {
    const { program, text } = parseExample(file);
    let count = 0;
    walkSpans(program, undefined, (span, parent) => {
      count++;
      expect(span.start).toBeLessThanOrEqual(span.end);
      expect(span.end).toBeLessThanOrEqual(text.length);
      expect(span.line).toBeGreaterThanOrEqual(1);
      if (parent) {
        expect(span.start).toBeGreaterThanOrEqual(parent.start);
        expect(span.end).toBeLessThanOrEqual(parent.end);
      }
    });
    expect(count).toBeGreaterThan(50);
  });

  it("builds the press_feeder tree", () => {
    const { station } = parseExample("press_feeder.tejun").program;
    expect(station.name.name).toBe("PressFeeder");
    expect(station.label?.value).toBe("プレス送り");
    expect(station.io.decls).toHaveLength(8);
    expect(station.devices.map((d) => [d.name.name, d.deviceKind.name, d.args.length])).toEqual([
      ["clamp", "Cylinder", 4],
    ]);
    expect(station.interlocks.map((i) => i.kind)).toEqual([
      "NeverInterlock",
      "RequiresInterlock",
      "ConditionInterlock",
    ]);
    expect(station.sequence.states.map((s) => s.name.name)).toEqual(["Idle", "Clamp", "Press", "Release"]);
    expect(station.handlers.map((h) => [h.trigger.kind, h.target.name])).toEqual([
      ["FaultTrigger", "Stopped"],
      ["NotExpr", "Stopped"],
    ]);
  });

  it("parses I/O declarations fully", () => {
    const { decls } = parseExample("press_feeder.tejun").program.station.io;
    const estop = decls.find((d) => d.name.name === "estop_ok")!;
    expect(estop).toMatchObject({
      direction: "input",
      type: { kind: "BoolType" },
      address: { text: "%IX0.7", area: "I", size: "X", byte: 0, bit: 7 },
      label: { value: "非常停止OK" },
    });
    expect(estop.safety).toBeDefined();
    const force = decls.find((d) => d.name.name === "press_force")!;
    expect(force.type).toMatchObject({ kind: "RealType", unit: { name: "kN" } });
    expect(force.address).toMatchObject({ size: "W", byte: 2, bit: undefined });
    expect(force.range).toMatchObject({ min: { value: 0 }, max: { value: 50 } });
  });

  it("parses statements and timeouts", () => {
    const { states } = parseExample("press_feeder.tejun").program.station.sequence;
    const [idle, clamp, press] = states;
    expect(idle!.statements.map((s) => s.kind)).toEqual(["OutputOn", "When"]);
    expect((idle!.statements[1] as AST.When).timeout?.kind).toBe("ForeverTimeout");
    const extend = clamp!.statements[0] as AST.DeviceAction;
    expect(extend).toMatchObject({
      kind: "DeviceAction",
      device: { name: "clamp" },
      action: { name: "extend" },
      timeout: {
        kind: "WithinTimeout",
        duration: { value: { value: 2 }, unit: { name: "s" } },
        fault: { name: "CLAMP_TIMEOUT" },
      },
    });
    expect(press!.statements[0]).toMatchObject({
      kind: "Hold",
      duration: { value: { value: 1500 }, unit: { name: "ms" } },
    });
  });

  it("parses a branch followed by a default transition", () => {
    const sense = parseExample("conveyor_sorter.tejun").program.station.sequence.states.find(
      (s) => s.name.name === "Sense",
    )!;
    expect(sense.statements.map((s) => s.kind)).toEqual(["When", "Goto"]);
    expect((sense.statements[0] as AST.When).timeout).toBeUndefined();
  });

  it("records exact spans", () => {
    const { program, text } = parseExample("press_feeder.tejun");
    const idle = program.station.sequence.states[0]!;
    expect(idle.span).toMatchObject({ line: 20, col: 5, endLine: 20 });
    expect(idle.name.span).toMatchObject({ line: 20, col: 11, endCol: 15 });
    expect(text.slice(idle.span.start, idle.span.end)).toBe(
      "state Idle    { conveyor on; when part_present forever -> Clamp }",
    );
    // Columns after Japanese text count code points.
    const estop = program.station.io.decls.find((d) => d.name.name === "estop_ok")!;
    const line8 = text.split("\n")[7]!;
    expect(estop.safety).toMatchObject({ line: 8, col: Array.from(line8).indexOf("s", 50) + 1 });
  });
});

describe("parser: expressions", () => {
  it.each([
    ["a or b and c", "(a or (b and c))"],
    ["a and b or c", "((a and b) or c)"],
    ["not a and b", "((not a) and b)"],
    ["not a < 1", "(not (a < 1))"],
    ["(a or b) and c", "((a or b) and c)"],
    ["x < 40 kN", "(x < 40kN)"],
    ["clamp.retracted and not y", "(clamp.retracted and (not y))"],
    ["(a < b) == (c < d)", "((a < b) == (c < d))"],
  ])("%s", (src, tree) => {
    expect(show(parseInterlockExpr(src))).toBe(tree);
  });
});

describe("parser: smaller cases", () => {
  it("accepts a trailing semicolon and an empty state", () => {
    const program = parseOk(
      "t.tejun",
      `station T { io { } sequence m { state A { -> B; } state B { } } }`,
    );
    expect(program.station.sequence.states[0]!.statements).toHaveLength(1);
    expect(program.station.sequence.states[1]!.statements).toHaveLength(0);
  });

  it("handles CRLF files the same as LF", () => {
    const text = readFileSync(new URL("press_feeder.tejun", examplesDir), "utf8");
    const lf = parseOk("a.tejun", text);
    const crlf = parseOk("a.tejun", text.replace(/\n/g, "\r\n"));
    expect(crlf).toEqual(lf);
  });
});
