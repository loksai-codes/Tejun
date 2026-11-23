# Building Tejun with Claude Code: prompts, phase by phase

How to use this file:
1. Put `CLAUDE.md` in the root of an empty repo folder.
2. Export the Tejun spec doc as Markdown and save it as `docs/SPEC.md`.
3. Open a terminal in that folder and run `claude`.
4. Paste one prompt at a time. Finish and test a phase before starting the next.
5. After each phase: read the diff, run the commands yourself, commit.

Tip: start each phase with "plan first, don't write code yet". Read the plan,
correct it, then say "go". You stay the architect; Claude Code types.

---

## Phase 0 — Learn the domain (do this yourself, 2–3 days, week 1)
Not a prompt. Install the free OpenPLC editor. Write a tiny ladder program and
a tiny Structured Text program (a conveyor that stops when a sensor sees a
part). Run both in its simulator. You need to understand what Tejun compiles to.

You can ask Claude Code questions while learning:
```
Explain IEC 61131-3 Structured Text to me like I'm a TypeScript developer.
Show a FUNCTION_BLOCK with a CASE state machine and a TON timer, and explain
each line. Don't create any files.
```

---

## Phase 1 — Repo setup and sample programs (week 1)
```
Read CLAUDE.md and docs/SPEC.md. Plan first, don't write code yet.

Set up the monorepo described in CLAUDE.md: npm workspaces with packages
compiler, runtime, cli; TypeScript strict; Vitest; a GitHub Actions workflow
that runs npm test on push. Add a placeholder test so CI is green.

Then write three example programs in examples/: press_feeder.tejun (from
CLAUDE.md), conveyor_sorter.tejun, and pick_place.tejun. Keep each under 40
lines and realistic. Also draft docs/grammar.ebnf covering all three.
Show me the examples before the grammar; I want to review the syntax first.
```
Done when: CI is green, the three examples read naturally to you, the grammar covers them.

---

## Phase 2 — Lexer, parser, AST (week 2)
```
Plan first. Implement the lexer and parser in packages/compiler following
docs/grammar.ebnf. Hand-written recursive descent with Pratt parsing for
expressions. Every AST node has a source span. Support Japanese text in
strings and labels.

Build diagnostics.ts with the Rust-style format from CLAUDE.md (code, file:line:col,
source line, caret underline, help). Syntax errors are T00xx.

Tests: all three examples parse; at least 8 broken inputs produce the right
error code and location (missing brace, bad address like %QX9, unknown
keyword, unterminated string, etc.) with golden output files.
Add `tejun check <file>` to the CLI that prints diagnostics or "OK".
```
Done when: `npx tejun check examples/press_feeder.tejun` prints OK, and broken files print pretty errors.

---

## Phase 3 — Types, units, I/O, timeouts, reachability (week 3)
```
Plan first. Add the checker in packages/compiler/src/checker/, one file per
family. Implement:
- T01xx: undefined names, type mismatch, unit mismatch (kN vs N), values
  outside a declared range.
- T03xx: two signals on one address, writing to an input, a `safety` signal
  used in normal logic.
- T02xx: a `when` or device action with no `within ... else fault` (or explicit
  `forever`); states unreachable from the start; states with no path to
  Stopped on fault/E-stop.
- T04xx: device used without its feedback sensors wired.
Each code gets a broken fixture and a golden file. Messages include a help line
and a Japanese line. Then build the state-graph IR in ir.ts.
```
Done when: each check fires on its fixture and the three examples still check clean.

---

## Phase 4 — Interlock proof and Structured Text output (week 4)
```
Plan first. Implement interlock checking as described in CLAUDE.md: explore all
reachable (state × input combination), inputs free each scan, timers as
done/not done. Report the shortest violating path in the diagnostic. Error out
clearly above 10 inputs.

Then implement codegen/st.ts: each station becomes a FUNCTION_BLOCK with a
CASE state machine, TON timers, fault codes, and Japanese labels as comments.
Outputs are assigned once per scan from the current state (no double coils).
Add `tejun build <file> -o out/` to the CLI. Add golden tests for the ST of
all three examples.
```
Then do this yourself: open `out/press_feeder.st` in the OpenPLC editor and make sure it compiles. If it doesn't, paste the error into Claude Code.

Done when: an interlock bug in a fixture shows a path; generated ST compiles in OpenPLC.

---

## Phase 5 — Interpreter and CLI simulation (week 5)
```
Plan first. Build packages/runtime: a scan-cycle interpreter that executes the
same IR as the ST generator. Each scan: read inputs, update timers, evaluate the
current state, write outputs, check interlocks at runtime too.

Add `tejun run <file>` with a scripted scenario file (e.g. at t=0 part_present
true; at t=1.2s clamp_ext_ls true) and a `--jam <sensor>` flag for fault
injection. Print a readable timeline of states, outputs, and faults.

Add an equivalence test: for each example and scenario, the interpreter's
output trace must match a trace computed from the ST semantics we generate.
```
Done when: `tejun run examples/press_feeder.tejun --jam clamp_ext_ls` shows CLAMP_TIMEOUT and outputs going safe.

---

## Phase 6 — Web playground and simulator (week 6)
```
Plan first. Create packages/playground: a Vite + React app, deployable to
GitHub Pages. Left: Monaco editor with Tejun syntax highlighting and live
diagnostics (red underlines with the same messages). Right top: a 2D SVG of the
station (conveyor, part, clamp, press, sensor lights) driven by the runtime.
Right bottom: tabs for generated ST and the event log. Buttons: Run, Pause,
Reset, Jam sensor (dropdown), language toggle EN/日本語 for messages.
The compiler and runtime run in the browser; no server.
Keep the visual style simple and clean.
```
Done when: someone with only a link can edit, see errors, run, and jam a sensor.

---

## Phase 7 — Docs, AI front end (optional), polish (week 7)
Docs:
```
Write docs/language-reference.md (every construct, with an example),
docs/checks.md (every diagnostic code, what it catches, a broken example and
the fix), and docs/for-ladder-engineers.md (Tejun explained by comparison with
ladder logic). Rewrite README.md: one-paragraph pitch, a GIF placeholder, the
playground link, a 3-command quickstart, the architecture diagram as Mermaid,
and limitations. Check that every command in the README actually works.
```

AI front end (only if phases 1–6 are solid):
```
Plan first. Add an optional "Draft from description" panel to the playground.
The user types a description in English or Japanese; we call an LLM API with
the language reference as context; it returns Tejun; we run the checker; if
there are errors, we send the diagnostics back and ask for a fix, up to 3
rounds. Show each round in the UI. The API key comes from the user and is never
committed. If no key is set, hide the panel.
```

---

## Before you submit (11–12 Jan)
```
Act as a strict hackathon judge. Clone this repo fresh into a temp folder,
follow only the README, and report everything that fails or confuses you.
Then run the full test suite and list any skipped or flaky tests.
```

## When things go wrong
- Claude Code goes in circles on a bug: stop it, paste the exact error, and ask
  it to explain the cause before changing code.
- A change got too big: `git diff`, then ask it to split the work into smaller
  commits, or reset and redo the phase in smaller steps.
- It wants to change the grammar or add a dependency: make it explain why first.
  CLAUDE.md tells it to ask.
