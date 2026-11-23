# Tejun (手順) — project guide for Claude Code

## Current state (as of 2026-11-23)
**No code exists yet.** The folder holds only planning documents:
- `CLAUDE.md` — this file (the target architecture and rules below are the plan)
- `BUILD_PROMPTS.md` — the phase-by-phase build plan (Phase 0–7), with the prompt to use for each phase

Not yet created: `docs/SPEC.md`, `docs/grammar.ebnf`, `package.json`, `packages/`,
`examples/`, `tests/`. Git is initialized (no commits yet). Next step is
Phase 1 in `BUILD_PROMPTS.md` (monorepo setup + example programs).
Until Phase 1 is done, the commands under "Tech and commands" will not work.
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
    state Idle    { conveyor on; when part_present -> Clamp }
    state Clamp   { clamp.extend within 2 s else fault CLAMP_TIMEOUT; -> Press }
    state Press   { hold 1500 ms; -> Release }
    state Release { clamp.retract within 2 s else fault RELEASE_TIMEOUT; -> Idle }
  }
  on fault        { outputs safe; -> Stopped }
  on not estop_ok { outputs safe; -> Stopped }
}
```
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

## Tech and commands (planned — set up in Phase 1)
- TypeScript (strict), Node 20+, npm workspaces, Vitest
- `npm install` · `npm test` · `npm run build` · `npx tejun check examples/press_feeder.tejun`
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
