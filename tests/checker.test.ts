// Checker behaviour that the one-error-per-file golden fixtures don't cover:
// several errors at once, ordering, and things that must NOT be reported.

import { describe, expect, it } from "vitest";
import { check } from "@tejun/compiler";

/** A valid station with replaceable parts. */
function station(parts: { io?: string; extra?: string; states?: string; handlers?: string } = {}): string {
  return `station T {
  io {
    input  a        : bool     @ %IX0.0
    input  b        : bool     @ %IX0.1
    input  ext_ls   : bool     @ %IX0.2
    input  ret_ls   : bool     @ %IX0.3
    input  estop_ok : bool     @ %IX0.7 safety
    input  force    : real<kN> @ %IW2 range 0..50
    output y        : bool     @ %QX0.0
    output ext      : bool     @ %QX0.1
    output ret      : bool     @ %QX0.2
${parts.io ?? ""}
  }
  device cyl : Cylinder(extend: ext, retract: ret, at_ext: ext_ls, at_ret: ret_ls)
${parts.extra ?? ""}
  sequence main {
${parts.states ?? "    state S { y on; when a forever -> S }"}
  }
${parts.handlers ?? "  on fault { outputs safe; -> Stopped }\n  on not estop_ok { outputs safe; -> Stopped }"}
}
`;
}

const codes = (text: string) => check("t.tejun", text).diagnostics.map((d) => d.code);

describe("checker", () => {
  it("accepts the base station", () => {
    expect(codes(station())).toEqual([]);
  });

  it("reports every error in one run, sorted by position", () => {
    const text = station({
      states: `    state S { zz on; when a forever -> Nowhere }
    state U { cyl.extend; -> S }`,
    });
    const lines = text.split("\n");
    const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    const result = check("t.tejun", text);
    expect(result.diagnostics.map((d) => [d.code, d.span.line, d.span.col])).toEqual([
      ["T0101", lineOf("zz on"), lines[lineOf("zz on") - 1]!.indexOf("zz") + 1],
      ["T0101", lineOf("zz on"), lines[lineOf("zz on") - 1]!.indexOf("Nowhere") + 1],
      ["T0201", lineOf("cyl.extend;"), lines[lineOf("cyl.extend;") - 1]!.indexOf("cyl") + 1],
    ]);
  });

  it("does not report a `when` followed by a default transition as a wait", () => {
    expect(codes(station({ states: "    state S { when a -> S; -> S }" }))).toEqual([]);
  });

  it("allows == and != between bools", () => {
    // As runtime monitors: `never (a == b)` would rightly fail the proof, since inputs are free.
    const handlers = "  on fault { outputs safe; -> Stopped }\n  on not estop_ok { outputs safe; -> Stopped }";
    const extra = "  interlock a == b else fault F\n  interlock a != not b else fault G";
    expect(codes(station({ extra, handlers }))).toEqual([]);
  });

  it("allows safety signals in interlocks and handlers", () => {
    expect(codes(station({ extra: "  interlock y requires estop_ok" }))).toEqual([]);
  });

  it.each([
    ["force <= 50 kN", "true"],
    ["force > 50 kN", "false"],
    ["force >= 0 kN", "true"],
    ["force == 60 kN", "false"],
    ["60 kN > force", "true"],
  ])("reports `%s` as always %s", (cond, word) => {
    const d = check("t.tejun", station({ extra: `  interlock ${cond} else fault F` }) + "")
      .diagnostics;
    // The fault needs a handler; ignore that error here.
    const range = d.filter((x) => x.code === "T0106");
    expect(range).toHaveLength(1);
    expect(range[0]!.message).toContain(`always ${word}`);
  });

  it("does not report a comparison inside the range", () => {
    expect(codes(station({ extra: "  interlock force < 40 kN else fault F", handlers: "  on fault { outputs safe; -> Stopped }\n  on not estop_ok { outputs safe; -> Stopped }" }))).toEqual([]);
  });

  it("explains an action used as a state and a state used as an action", () => {
    const result = check(
      "t.tejun",
      station({
        extra: "  interlock y requires cyl.extend",
        states: "    state S { cyl.retracted forever; -> S }",
      }),
    );
    expect(result.diagnostics.map((d) => d.help)).toEqual([
      "`extend` is an action; the state is `extended`",
      "`retracted` is a state; the action is `retract`",
    ]);
  });

  it("says units are case-sensitive", () => {
    const d = check("t.tejun", station({ io: "    input  p : real<kn> @ %IW4" })).diagnostics;
    expect(d.map((x) => [x.code, x.help])).toEqual([["T0105", "units are case-sensitive; did you mean `kN`?"]]);
  });

  it("does not cascade from an unknown signal unit into unit mismatches", () => {
    const text = station({
      io: "    input  p : real<kn> @ %IW4",
      extra: "  interlock p < 4 kN else fault F",
      handlers: "  on fault { outputs safe; -> Stopped }\n  on not estop_ok { outputs safe; -> Stopped }",
    });
    expect(codes(text)).toEqual(["T0105"]);
  });

  it("does not check a device of unknown kind any further", () => {
    const text = station({ states: "    state S { cyl.whatever forever; -> S }" }).replace("Cylinder", "Robot");
    expect(codes(text)).toEqual(["T0401"]);
  });

  it("points at a missing `safety` mark when the E-stop handler exists", () => {
    const text = station().replace(" safety", "");
    const d = check("t.tejun", text).diagnostics;
    expect(d.map((x) => x.code)).toEqual(["T0205"]);
    expect(d[0]!.help).toContain("`estop_ok` is not marked `safety`");
  });

  it("reports the E-stop handler missing when no safety input exists", () => {
    const text = station({ handlers: "  on fault { outputs safe; -> Stopped }" }).replace(" safety", "");
    const d = check("t.tejun", text).diagnostics;
    expect(d.map((x) => x.code)).toEqual(["T0205"]);
    expect(d[0]!.help).toContain("declare the E-stop input");
  });
});

describe("interlock proof", () => {
  it("reports an output that ignores the input its interlock requires", () => {
    const d = check("t.tejun", station({ extra: "  interlock y requires b" })).diagnostics;
    expect(d.map((x) => x.code)).toEqual(["T0203"]);
    expect(d[0]!.notes).toContain("path: S (at startup)");
  });

  it("accepts the same interlock once the sequence reacts to the input", () => {
    const states = "    state S { when b forever -> On }\n    state On { y on; when not b forever -> S }";
    expect(codes(station({ extra: "  interlock y requires b", states }))).toEqual([]);
  });

  it("counts E-stop as reacting in the same scan", () => {
    // y is ON in S, but outputs are written after the E-stop handler runs.
    expect(codes(station({ extra: "  interlock y requires estop_ok" }))).toEqual([]);
  });
});
