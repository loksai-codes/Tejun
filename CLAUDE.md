# Tejun (手順) — project guide for Claude Code

## Current state (as of 2026-11-23)
Phase 1 done (`BUILD_PROMPTS.md` has the phase plan).
- npm-workspaces monorepo (`packages/compiler`, `packages/runtime`,
  `packages/cli`), strict TypeScript, Vitest, GitHub Actions CI. The packages are
  placeholders; `tejun check|build|run` print "not implemented yet".
- `examples/`: press_feeder, conveyor_sorter, pick_place (each ≤ 40 lines, tested).
- `docs/grammar.ebnf` covers all three examples.
- Next: Phase 2 (lexer, parser, AST, diagnostics, `tejun check`).
- Not added yet: `docs/SPEC.md` (work from this file until it exists). No GitHub remote yet.
Update this section as phases are completed.

## What this project is
Tejun is a small domain-specific language for programming one factory machine
station (sensors, cylinders, conveyors, a press). Its compiler proves safety
rules before anything runs, then emits IEC 61131-3 Structured Text (ST) that
real PLC tools (OpenPLC, CODESYS) can import. The same program runs in a
browser simulator. Built for the Syntax Summit hackathon (deadline 14 Jan 2027;
we submit 12 Jan).

Full spec: `docs/SPEC.md` (not added yet — the user exports it from the spec doc).
Read it before any design decision once it exists.

## The one idea that must never be lost
The compiler catches the bugs that break machines **before code runs**:
interlock violations, waits with no timeout, dead-end states, I/O misuse,
unit/range errors, device contract errors. Double coils must be impossible to
write (each output is decided in one place, per state). Every feature we add
must serve this idea or the demo.

## Language at a glance
```
station PressFeeder "プレス送り" {
  io {
    input  part_present : bool     @ %IX0.0  "ワーク検出"
    input  clamp_ext_ls : bool     @ %IX0.1
    input  clamp_ret_ls : bool     @ %IX0.2
    input  estop_ok     : bool     @ %IX0.7  safety
    output clamp_out    : bool     @ %QX0.0
    output clamp_in     : bool     @ %QX0.1
    output conveyor     : bool     @ %QX0.2
    input  press_force  : real<kN> @ %IW2    range 0..50
  }
  device clamp : Cylinder(extend: clamp_out, retract: clamp_in,
                          at_ext: clamp_ext_ls, at_ret: clamp_ret_ls)
  interlock never (clamp_out and clamp_in)
  interlock conveyor requires clamp.retracted
  interlock press_force < 40 kN else fault OVERLOAD
  sequence main {
    state Idle    { conveyor on; when part_present forever -> Clamp }
    state Clamp   { clamp.extend within 2 s else fault CLAMP_TIMEOUT; -> Press }
    state Press   { hold 1500 ms; -> Release }
    state Release { clamp.retract within 2 s else fault RELEASE_TIMEOUT; -> Idle }
  }
  on fault        { outputs safe; -> Stopped }
  on not estop_ok { outputs safe; -> Stopped }
}
```
Semantics agreed in Phase 1 (the grammar and examples follow them):
- A wait carries its timeout before the arrow: `when c within 500 ms else fault F -> S`,
  or `when c forever -> S` when waiting forever is intended. Device actions use the
  same `within … else fault …` form.
- Transitions in a state are tried top to bottom; the first true one wins. A `when`
  followed by a bare `-> S` is a branch and needs no timeout.
- Outputs not switched `on` in a state are OFF in that state (there is no `off`).
- `Stopped` is a built-in state; fault and E-stop handlers go there.
- In `io` lines the label comes before `safety` / `range`.
- Device kinds: only `Cylinder` (double-acting: extend, retract, at_ext, at_ret).

The grammar lives in `docs/grammar.ebnf`. If you change syntax, update the
grammar, `docs/language-reference.md`, and the examples in the same change.

## Architecture (pipeline)
`source → lexer → parser → AST → checker → state-graph IR → { ST codegen, PLCopen XML, interpreter }`

- `packages/compiler/src/lexer.ts` — hand-written; UTF-8 (Japanese strings and labels)
- `packages/compiler/src/parser.ts` — hand-written recursive descent + Pratt for expressions. No parser generators.
- `packages/compiler/src/ast.ts` — every node carries a source span (line, col, endLine, endCol)
- `packages/compiler/src/checker/` — one file per check family (types, units, io, timeouts, reachability, interlocks)
- `packages/compiler/src/ir.ts` — state graph: states, transitions, per-state output assignments
- `packages/compiler/src/codegen/st.ts` — FUNCTION_BLOCK with a CASE state machine and TON timers
- `packages/compiler/src/diagnostics.ts` — Rust/Elm-style errors with codes, caret underline, help text, Japanese line
- `packages/runtime/` — scan-cycle interpreter that reads the same IR as codegen
- `packages/cli/` — `tejun check | build | run`
- `packages/playground/` — Monaco editor + 2D SVG simulator (later phase)

The interpreter and ST codegen MUST read the same IR so the simulator behaves
exactly like the generated PLC code.

## Interlock checking
Explore every reachable (state × input combination). Each input is free
(true/false) each scan; timers are abstracted to done / not done. If any
reachable combination violates an interlock, report the shortest path of
states. Cap stations at ~10 inputs; emit a clear error above the cap.

Device-state interlocks such as `conveyor requires clamp.retracted` must use the
device position implied by its last completed action (confirmed by its feedback
sensor), not the raw sensor as a free input; otherwise every state that runs the
conveyor would be reported as a violation.

## Diagnostics format
```
error[T0203]: interlock violated: clamp_out and clamp_in can both be ON
  --> examples/press_feeder.tejun:24:5
   |
24 |     state Release { clamp.retract within 2 s ... }
   |     ^^^^^^^^^^^^^ entering Release while clamp_out is still ON
   |
   = path: Idle -> Clamp -> Press -> Release
   = help: turn clamp_out off before retracting
   = 日本語: インターロック違反: clamp_out と clamp_in が同時にONになります
```
Codes: T00xx syntax, T01xx names/types/units, T02xx safety (interlocks,
timeouts, reachability), T03xx I/O, T04xx devices. Never print a raw stack
trace to the user.

## Tech and commands
- TypeScript (strict, ESM, `NodeNext` modules: relative imports end in `.js`),
  Node 22+, npm workspaces, Vitest. CI runs on Node 22 and 24.
- Dev dependencies (exact versions pinned): `typescript`, `vitest`, `@types/node`.
- `npm install` · `npm run build` (`tsc -b`) · `npm test` (Vitest, imports packages
  from source, no build needed) · `npm run typecheck` (build + type-check tests)
- `npx tejun ...` runs the compiled CLI; run `npm run build` first.
  The `bin` launcher `packages/cli/bin/tejun.js` is committed so npm can link it before a build.
- CLI logic lives in `packages/cli/src/main.ts` as a pure `runCli(argv)` returning
  `{ code, stdout, stderr }`; `src/index.ts` only does process I/O. Keep it that way for testing.
- Allowed runtime dependencies: none in compiler/runtime. Playground may use Monaco and React.
- Ask before adding any dependency.

## Testing rules
- Every diagnostic code has at least one failing example in `tests/fixtures/errors/` and a golden expected-output file.
- Every example in `examples/` must check clean, compile, and simulate in tests.
- Golden-file tests for generated ST (`tests/golden/*.st`). Update goldens only on purpose, and say so.
- Run `npm test` before saying a task is done. Fix failures; don't skip tests.

## Working style
- Plan first for anything touching more than one file; show the plan, then build.
- Small commits with clear messages, one feature each.
- Git identity: user.name `loksai-codes`, user.email `loksaipalyam.in@gmail.com`.
  Check `git config user.name` / `git config user.email` before committing.
- Never add `Co-Authored-By` lines or any Claude/AI attribution to commits or PRs.
- Keep the language small. Prefer a clear error over a clever feature.
- Write code comments and docs in English; user-facing messages in English + Japanese.

## Environment notes
- Development is on Windows 11; the repo lives in a OneDrive-synced folder.
  Keep `node_modules/` and `out/` in `.gitignore`, and use forward-slash paths
  in scripts so they work in both PowerShell and Git Bash.

## Out of scope (don't build unless asked)
Multi-station lines, PackML states, robot motion, ladder editing, real
hardware I/O, any claim of safety certification.
