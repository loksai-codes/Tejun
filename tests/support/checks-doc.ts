// Source for docs/checks.md. The example output for each code is the real
// golden output of its first fixture in tests/fixtures/errors/, so the page
// cannot drift from what `tejun check` prints. tests/docs.test.ts renders it
// and compares it with the committed file.

import { DIAGNOSTIC_CODES, type DiagnosticCode } from "@tejun/compiler";

interface Entry {
  /** What the check catches and why it matters. */
  why: string;
  /** How to fix it. */
  fix: string;
}

export const CHECKS: Record<DiagnosticCode, Entry> = {
  T0001: {
    why: "A character that cannot start any token. Common causes: full-width punctuation typed with a Japanese IME (`；`, `（`), Japanese text outside a string or comment, `=` instead of `==`.",
    fix: "Use the ASCII character the hint names, or move the text into a `\"string\"` or `// comment`.",
  },
  T0002: {
    why: "A string that is not closed before the end of the line. Strings cannot span lines.",
    fix: "Add the closing `\"`.",
  },
  T0003: {
    why: "A malformed I/O address, such as `%QX9` (no bit number), `%QX0.8` (bit above 7) or `%MX0.0` (memory area). Wrong addresses are a classic way to drive the wrong actuator.",
    fix: "Write `%IX<byte>.<bit>` / `%QX<byte>.<bit>` with a bit from 0 to 7, or `%IW<n>` / `%QW<n>`. For a bit above 7 the hint gives the next byte.",
  },
  T0010: {
    why: "The parser expected one thing and found another, such as a missing `:` in an I/O line or a wrong handler body.",
    fix: "Write what the message says is expected; the help line shows the full form of the construct.",
  },
  T0011: {
    why: "The file ends while a `{` is still open. The caret points at the `{` that was never closed.",
    fix: "Add the matching `}`.",
  },
  T0012: {
    why: "A word where a keyword belongs, usually a typo such as `interlok` or `wen`.",
    fix: "Use the keyword suggested by `did you mean`.",
  },
  T0013: {
    why: "A reserved keyword used as a name, e.g. a signal called `state`.",
    fix: "Choose another name.",
  },
  T0014: {
    why: "A station section out of order, or repeated. The order is fixed so every station reads the same way.",
    fix: "Order the sections `io`, `device`, `interlock`, `sequence`, `on`, with one `io` and one `sequence`.",
  },
  T0015: {
    why: "A chained comparison such as `0 < x < 40`, which does not mean what it looks like in most languages.",
    fix: "Compare each pair and join them: `0 < x and x < 40`.",
  },
  T0016: {
    why: "Two statements in a state with no `;` between them.",
    fix: "Separate statements with `;`.",
  },
  T0101: {
    why: "A signal, device or state that is used but never declared.",
    fix: "Fix the spelling (see `did you mean`), or declare it.",
  },
  T0102: {
    why: "The same name declared twice, or a state named `Stopped`, which is built in.",
    fix: "Rename one of them. Never declare `Stopped`; handlers go there automatically.",
  },
  T0103: {
    why: "A value of the wrong type: a real signal used as a condition, a bool compared with `<`, a device used as a signal, a real output switched on.",
    fix: "Compare reals with a limit (`press_force < 40 kN`); use bools directly; use a device state like `clamp.retracted`.",
  },
  T0104: {
    why: "A comparison whose sides have different units, or a number without a unit compared with a signal that has one. Tejun never converts units silently.",
    fix: "Write the number in the signal's unit; for convertible units the help line gives the converted value (`40 N` → `0.04 kN`).",
  },
  T0105: {
    why: "A unit Tejun does not know, such as `msec` or `kn` (units are case-sensitive).",
    fix: "Use a known unit: `N kN mm m bar kPa MPa degC rpm A V`, and `ms` or `s` for times.",
  },
  T0106: {
    why: "A comparison that can never change result over the signal's declared range (e.g. `press_force < 60 kN` with range 0..50 is always true), so it protects nothing; or an empty range.",
    fix: "Use a limit inside the range, or correct the range.",
  },
  T0107: {
    why: "A name that would break the generated Structured Text: an ST reserved word (`step`, `time`, `do`…), a name starting with `tj_` (reserved for generated code), or two names that differ only in case (ST ignores case).",
    fix: "Rename it.",
  },
  T0201: {
    why: "A wait with no timeout: a device action, or a `when` that can wait. If a sensor fails, the machine would wait forever without raising a fault.",
    fix: "Add `within <time> else fault <CODE>`, or write `forever` when waiting forever is intended (e.g. waiting for the next part).",
  },
  T0202: {
    why: "A state that no transition leads to from the first state. Unreachable logic is dead code that hides mistakes.",
    fix: "Add a transition to it, or remove it.",
  },
  T0203: {
    why: "An interlock can be violated. The proof explores every reachable state with every combination of inputs and shows the shortest path. A common case: a device position is unknown at startup, or a device is still moving.",
    fix: "Follow the help line: home the device first (`state Home { clamp.retract … -> Idle }`), switch the output on only after the move is confirmed, or switch one of the outputs off in that state.",
  },
  T0204: {
    why: "A fault can be raised but nothing handles it.",
    fix: "Add `on fault { outputs safe; -> Stopped }`.",
  },
  T0205: {
    why: "The station has no E-stop handler, or its E-stop input is not marked `safety`.",
    fix: "Declare the E-stop input with `safety` and add `on not estop_ok { outputs safe; -> Stopped }`.",
  },
  T0206: {
    why: "A state with no transition out. The machine would stay there until a fault or E-stop.",
    fix: "Add a transition, e.g. back to the idle state.",
  },
  T0207: {
    why: "A statement after the state's transitions, or after a bare `-> State` where it can never run.",
    fix: "Write outputs and the step first, then the transitions; a bare `-> State` comes last.",
  },
  T0208: {
    why: "Two steps (device actions or `hold`s) in one state. A state waits for one thing at a time, which keeps timeouts and faults unambiguous.",
    fix: "Move the second step into its own state.",
  },
  T0209: {
    why: "A fault or E-stop handler that goes somewhere other than `Stopped`, e.g. restarting at `Idle`.",
    fix: "End handlers with `-> Stopped`. Restarting after a fault is a separate, deliberate step.",
  },
  T0210: {
    why: "The station has more than 10 free inputs to explore, too many for the interlock proof to finish quickly.",
    fix: "Split the machine into smaller stations.",
  },
  T0301: {
    why: "Two signals on the same address.",
    fix: "Give each signal its own address.",
  },
  T0302: {
    why: "An input on an output address (`%Q…`) or an output on an input address (`%I…`).",
    fix: "Inputs use `%I`, outputs use `%Q`.",
  },
  T0303: {
    why: "A bool on a word address or a real on a bit address.",
    fix: "Bools use bit addresses (`%IX0.0`), reals use word addresses (`%IW2`).",
  },
  T0304: {
    why: "An input switched on, or limited with `requires`. Inputs come from sensors; only outputs can be driven.",
    fix: "Switch an output instead. For conditions on inputs use `interlock never (…)` or `<cond> else fault`.",
  },
  T0305: {
    why: "A safety input (E-stop, guard) used in sequence logic. The stop path must stay independent of the sequence.",
    fix: "Handle it only in `on not estop_ok { … }` and interlocks.",
  },
  T0306: {
    why: "`safety` on an output or a real input.",
    fix: "Mark only bool inputs such as E-stop or guard switches as `safety`.",
  },
  T0401: {
    why: "A device kind Tejun does not know, usually a typo.",
    fix: "Use `Cylinder` (the only device kind for now).",
  },
  T0402: {
    why: "A device with a parameter missing, typically a feedback sensor. Without it Tejun cannot confirm that a move finished.",
    fix: "Wire every parameter: `extend`, `retract`, `at_ext`, `at_ret`.",
  },
  T0403: {
    why: "A device parameter that does not exist, or one given twice.",
    fix: "Use the suggested parameter name; give each parameter once.",
  },
  T0404: {
    why: "A device parameter wired to the wrong kind of signal, e.g. a sensor parameter wired to an output.",
    fix: "Valve parameters take bool outputs; sensor parameters take bool inputs.",
  },
  T0405: {
    why: "A device action or state that does not exist, including mixing them up (`clamp.extend` where `clamp.extended` is meant).",
    fix: "Actions are `extend`/`retract`; states are `extended`/`retracted`.",
  },
  T0406: {
    why: "An output driven from two places: switched directly while a device drives it, or wired to two device parameters. In ladder logic this is the double coil (二重コイル).",
    fix: "Let the device drive it (`clamp.extend …`), or wire a separate output.",
  },
};

/** Render docs/checks.md. `examples` maps each code to [fixture path, golden output]. */
export function renderChecksDoc(examples: ReadonlyMap<string, [string, string]>): string {
  const codes = Object.keys(DIAGNOSTIC_CODES) as DiagnosticCode[];
  const groups: [string, string][] = [
    ["T00", "Syntax"],
    ["T01", "Names, types and units"],
    ["T02", "Safety: timeouts, reachability, handlers, interlocks"],
    ["T03", "I/O"],
    ["T04", "Devices"],
  ];
  const lines: string[] = [
    "# Diagnostic codes",
    "",
    "<!-- Generated by tests/docs.test.ts from tests/support/checks-doc.ts and the",
    "     fixtures in tests/fixtures/errors/. Do not edit by hand; regenerate with",
    "     UPDATE_GOLDEN=1 npm test. -->",
    "",
    "Every problem `tejun check` reports has a code, the exact place in the source,",
    "a help line, and the message in Japanese. Syntax errors stop at the first one;",
    "every other check reports all problems at once. Each example below is the real",
    "output for a broken file in `tests/fixtures/errors/`.",
    "",
  ];
  for (const [prefix, title] of groups) {
    lines.push(`- **${prefix}xx ${title}:** ${codes.filter((c) => c.startsWith(prefix)).map((c) => `[${c}](#${c.toLowerCase()})`).join(" ")}`);
  }
  for (const [prefix, title] of groups) {
    lines.push("", `## ${prefix}xx: ${title}`);
    for (const code of codes.filter((c) => c.startsWith(prefix))) {
      const entry = CHECKS[code];
      const example = examples.get(code);
      lines.push("", `### ${code}`, "", `**${DIAGNOSTIC_CODES[code]}.** ${entry.why}`, "");
      if (example) {
        lines.push(`From \`${example[0]}\`:`, "", "```text", example[1].trimEnd(), "```", "");
      }
      lines.push(`**Fix:** ${entry.fix}`);
    }
  }
  return lines.join("\n") + "\n";
}
