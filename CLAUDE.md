# Tejun (手順) — project guide for Claude Code

## Current state (as of 2026-11-23)
Phase 3 done (`BUILD_PROMPTS.md` has the phase plan).
- Phase 1: npm-workspaces monorepo, strict TypeScript, Vitest, GitHub Actions CI;
  `examples/` (press_feeder, conveyor_sorter, pick_place); `docs/grammar.ebnf`.
- Phase 2: lexer, parser, AST, diagnostics; syntax codes T0001–T0016; `tejun check <file>`.
- Phase 3: checker (`packages/compiler/src/checker/`) with T0101–T0106, T0201–T0209
  (T0203 reserved for Phase 4), T0301–T0306, T0401–T0406; state-graph IR (`ir.ts`)
  with golden JSON per example in `tests/golden/`.
- `tejun build|run` still print "not implemented yet".
- Next: Phase 4 (interlock proof T0203, Structured Text codegen, `tejun build`).
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

Rules agreed in Phase 3 (enforced by the checker):
- One step per state: at most one device action or `hold` (T0208).
- Transitions come after the outputs and the step; nothing follows a bare
  `-> S` (T0207). So a state means: its outputs, plus its step's drive output,
  are ON for the whole state; the step runs; then transitions are tried in order.
- No automatic unit conversion: `40 N` against a `kN` signal is an error (T0104).
  Units: N, kN, mm, m, bar, kPa, MPa, degC, rpm, A, V; durations use ms or s.
- Safety inputs may appear in handlers and interlocks, never in state logic (T0305);
  `safety` only on bool inputs (T0306).
- Every station needs `on not <safety input> { … }` (T0205) and, if it can fault,
  `on fault { … }` (T0204); handlers must go to `Stopped` (T0209).
- Address clashes are exact duplicates only (`%IW0` vs `%IX0.x` overlap differs between tools).
- Cylinder: actions `extend`/`retract`, states `extended`/`retracted`, all four
  parameters required. Definitions live in `device-kinds.ts`.

The grammar lives in `docs/grammar.ebnf`. If you change syntax, update the
grammar, `docs/language-reference.md`, and the examples in the same change.

## Architecture (pipeline)
`source → lexer → parser → AST → checker → state-graph IR → { ST codegen, PLCopen XML, interpreter }`

- `packages/compiler/src/lexer.ts` — hand-written; UTF-8 (Japanese strings and labels)
- `packages/compiler/src/parser.ts` — hand-written recursive descent + Pratt for expressions. No parser generators.
- `packages/compiler/src/ast.ts` — every node carries a source span (line, col, endLine, endCol)
- `packages/compiler/src/checker/` — one file per check family: `names` (T0101–T0102),
  `units` (T0104–T0106), `types` (T0103), `io` (T03xx), `devices` (T04xx), `states`
  (T0207–T0208), `timeouts` (T0201), `reachability` (T0202, T0204–T0206, T0209);
  `interlocks` comes in Phase 4. `context.ts` holds the symbol table and helpers;
  `index.ts` runs the passes in order and sorts diagnostics by position.
- `packages/compiler/src/ir.ts` — state graph built only from a clean program: per state,
  `outputs`, one optional `step` (device action with `drive`/`done`/timeout, or hold),
  ordered `transitions`; device states stay high-level (`device_state`) for Phase 4.
  `outputsOn(state)` gives every output ON in a state.
- `packages/compiler/src/device-kinds.ts` — built-in device kinds (only `Cylinder`)
- `packages/compiler/src/api.ts` — public `tokenize`, `parse`, `check` (check returns `ir` when clean)
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

How diagnostics work in code:
- All codes are registered in `DIAGNOSTIC_CODES` in `diagnostics.ts`; add new codes there.
- The checker reports every error at once. Passes after `names` skip anything that
  did not resolve (and similar follow-on cases), so one mistake gives one error.
- Every diagnostic has an English `message`, a Japanese `messageJa`, a `span`, and
  usually a `label` (after the carets) and a `help` line.
- Lexer and parser stop at the first syntax error by throwing `DiagnosticAbort`
  internally; the public API in `api.ts` (`tokenize`, `parse`, `check`) catches it
  and returns diagnostics as values. Nothing in the public API throws for user errors.
- Carets are aligned by display width (Japanese/full-width chars count as 2).
- Source text is normalized on load (BOM removed, CRLF → LF); paths are shown with `/`.

## Tech and commands
- TypeScript (strict, ESM, `NodeNext` modules: relative imports end in `.js`),
  Node 22+, npm workspaces, Vitest. CI runs on Node 22 and 24.
- Dev dependencies (exact versions pinned): `typescript`, `vitest`, `@types/node`.
- `npm install` · `npm run build` (`tsc -b`) · `npm test` (Vitest, imports packages
  from source, no build needed) · `npm run typecheck` (build + type-check tests)
- `npx tejun ...` runs the compiled CLI; run `npm run build` first.
  The `bin` launcher `packages/cli/bin/tejun.js` is committed so npm can link it before a build.
- CLI logic lives in `packages/cli/src/main.ts` as `runCli(argv, io?)` returning
  `{ code, stdout, stderr }`, with file reads injected through `io` so tests never touch
  the disk; `src/index.ts` only does process I/O. Keep it that way for testing.
- `tejun check` exit codes: 0 OK, 1 the program has errors, 2 could not check
  (usage error, unreadable file, internal error). Diagnostics go to stdout.
- Allowed runtime dependencies: none in compiler/runtime. Playground may use Monaco and React.
- Ask before adding any dependency.

## Testing rules
- Every diagnostic code has at least one failing example in `tests/fixtures/errors/` and a golden expected-output file.
  Fixtures are named `<CODE>_<what>.tejun` (e.g. `T0010_missing_colon.tejun`) with a matching
  `.expected`; the test checks the file produces exactly that one code. A test fails if a
  registered code has no fixture.
- Regenerate goldens on purpose with `UPDATE_GOLDEN=1 npm test` (Git Bash) or
  `$env:UPDATE_GOLDEN=1; npm test; Remove-Item Env:UPDATE_GOLDEN` (PowerShell),
  then read the diff before committing.
- Each example's IR is a golden JSON file in `tests/golden/<example>.ir.json`
  (spans left out); regenerate the same way and review the state graph in the diff.
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
