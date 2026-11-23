# Tejun (手順) — project guide for Claude Code

## Current state (as of 2026-11-23)
Phase 5 done (`BUILD_PROMPTS.md` has the phase plan).
- Phase 1: npm-workspaces monorepo, strict TypeScript, Vitest, GitHub Actions CI;
  `examples/` (press_feeder, conveyor_sorter, pick_place); `docs/grammar.ebnf`.
- Phase 2: lexer, parser, AST, diagnostics; syntax codes T0001–T0016; `tejun check <file>`.
- Phase 3: checker (`packages/compiler/src/checker/`) with T0101–T0107, T0201–T0209,
  T0301–T0306, T0401–T0406; state-graph IR (`ir.ts`) with golden JSON per example.
- Phase 4: interlock proof (T0203, T0210) in `checker/interlocks.ts`; Structured Text
  generator `codegen/st.ts` with golden `.st` per example; `tejun build <file> [-o dir]`.
  press_feeder and conveyor_sorter gained a `Home` state because the proof found
  they ran the conveyor/belt before the cylinder was confirmed retracted.
- Not yet verified: the generated `.st` compiling in OpenPLC (the user does this by
  hand; matiec is not available in this environment). If it reports an error, fix
  `codegen/st.ts` and regenerate the ST goldens on purpose.
- Phase 5: `packages/runtime` (IR interpreter, simulated machine, scenarios, timeline);
  `tejun run`; each example has a `.scenario`; equivalence test proves the simulator
  matches the generated ST scan by scan.
- Next: Phase 6 (web playground: Monaco editor, live diagnostics, SVG simulator).
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
    state Home    { clamp.retract within 2 s else fault HOME_TIMEOUT; -> Idle }
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
- Signal and station names must be usable in Structured Text: no ST reserved words,
  no `tj_` prefix (reserved for generated code), no names differing only in case (T0107).

The grammar lives in `docs/grammar.ebnf`. If you change syntax, update the
grammar, `docs/language-reference.md`, and the examples in the same change.

## Architecture (pipeline)
`source → lexer → parser → AST → checker → state-graph IR → { ST codegen, PLCopen XML, interpreter }`

- `packages/compiler/src/lexer.ts` — hand-written; UTF-8 (Japanese strings and labels)
- `packages/compiler/src/parser.ts` — hand-written recursive descent + Pratt for expressions. No parser generators.
- `packages/compiler/src/ast.ts` — every node carries a source span (line, col, endLine, endCol)
- `packages/compiler/src/checker/` — one file per check family: `names` (T0101–T0102),
  `target` (T0107), `units` (T0104–T0106), `types` (T0103), `io` (T03xx), `devices`
  (T04xx), `states` (T0207–T0208), `timeouts` (T0201), `reachability` (T0202,
  T0204–T0206, T0209). `context.ts` holds the symbol table and helpers; `index.ts`
  runs the passes in order and sorts diagnostics by position. `interlocks.ts`
  (T0203, T0210) runs on the IR afterwards, only when everything else is clean.
- `packages/compiler/src/ir.ts` — state graph built only from a clean program: per state,
  `outputs`, one optional `step` (device action with `drive`/`done`/timeout, or hold),
  ordered `transitions`; device states stay high-level (`device_state`).
  `outputsOn(state)` gives every output ON in a state.
- `packages/compiler/src/device-kinds.ts` — built-in device kinds (only `Cylinder`)
- `packages/compiler/src/api.ts` — public `tokenize`, `parse`, `check` (returns `ir` when
  clean, including the interlock proof), `build` (also returns `st`)
- `packages/compiler/src/codegen/st.ts` — one file with FUNCTION_BLOCK `<Station>` (CASE state
  machine, one `TON`, `tj_state`/`tj_fault` outputs, `tj_pos_<device>` tracked positions),
  PROGRAM `<Station>Program` (binds `AT %IX…` addresses; `%IW` words are UINT scaled
  0..65535 → declared range) and an OpenPLC `CONFIGURATION` (20 ms task). States, faults
  and positions are integer literals with comments; every output is assigned exactly
  once at the end of the block; generated names use the `tj_` prefix.
- `packages/compiler/src/version.ts` — `VERSION`, used by the CLI and the ST header
- `packages/compiler/src/diagnostics.ts` — Rust/Elm-style errors with codes, caret underline, help text, Japanese line
- `packages/runtime/` — depends only on `@tejun/compiler` (for IR types):
  - `station.ts` — `StationRuntime`, the scan-cycle interpreter; same scan order as
    `codegen/st.ts`; re-checks never/requires after outputs and only *reports* violations
  - `timer.ts` — `Ton`, the IEC/matiec on-delay timer on a simulated clock
  - `plant.ts` — simulated machine: each Cylinder starts retracted, travels 300 ms,
    drives its end sensors; both outputs off holds position
  - `scenario.ts` — scenario files (`at <time> <input> = <value>`,
    `follow <input> = <output> [after <time>]`, `until <time>`, `#` comments)
  - `simulate.ts` — the loop: scenario + plant + follows + jams → one scan → plant moves;
    returns events and a per-scan trace
  - `timeline.ts` — the text timeline `tejun run` prints
- `packages/cli/` — `tejun check | build | run`
- `packages/playground/` — Monaco editor + 2D SVG simulator (later phase)

The interpreter and ST codegen MUST read the same IR so the simulator behaves
exactly like the generated PLC code.

## Interlock checking
Implemented in `checker/interlocks.ts`. Breadth-first search over configurations
(state, step done or not, device positions), so the first violation found has the
shortest path. Model, per scan:
- Free inputs are true or false: bool inputs the logic reads, plus each distinct
  comparison on a real input. At most 10 (T0210 above that).
- The state's timer is done or not done.
- Device positions are tracked, not read from sensors: "moving" while an action
  runs, the action's position once its done sensor confirms, "unknown" at startup.
  So a station whose first state needs a device position must home it first.
- Runtime monitors (`<cond> else fault`) and E-stop handlers can stop the machine;
  in `Stopped` every output is OFF.
- Outputs are written at the end of the scan, so each interlock is checked against
  the state a scan ends in together with the inputs that scan read.
- A step completes in one scan; its transitions run from the next scan.
`never` and `requires` are proved; `<cond> else fault` is a runtime monitor only.
The ST generator follows exactly this scan order (see the header of `codegen/st.ts`);
`runtime/station.ts` follows it too, and `tests/equivalence.test.ts` checks all three agree.

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
  `{ code, stdout, stderr }`, with file reads, directory creation and writes injected
  through `io` so tests never touch the disk; `src/index.ts` only does process I/O.
  Keep it that way for testing.
- `tejun build <file> [-o dir]` writes `<dir>/<name>.st` (default dir `out`, gitignored);
  on errors it prints diagnostics like `tejun check` and writes nothing.
- `tejun run <file> [--scenario f] [--jam sensor[=on|off]]... [--until 5s] [--scan 20ms]`
  simulates and prints a timeline. Default scenario: `<name>.scenario` next to the program,
  if present. Safety inputs start ON, other inputs OFF/0. Device sensors belong to the
  simulated machine; scenarios may not set them (use `--jam`). Runs end at `Stopped` or
  the end time (scenario `until`, `--until`, else 10 s).
  Example: `npx tejun run examples/press_feeder.tejun --jam clamp_ext_ls` → CLAMP_TIMEOUT.
- Exit codes: 0 OK (for `run`: the simulation ran, even if the machine faulted),
  1 the program or scenario has errors, 2 could not run (usage error,
  unreadable/unwritable file, internal error). Diagnostics go to stdout.
- To try generated code in OpenPLC: `npx tejun build examples/press_feeder.tejun`, then
  upload `out/press_feeder.st` in OpenPLC Runtime (Programs → Upload Program). For
  CODESYS, copy only the FUNCTION_BLOCK.
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
- Every example in `examples/` must check clean, compile, and simulate in tests, and
  needs a `<name>.scenario`. Golden timelines: `tests/golden/<name>.timeline.txt`
  (plus `press_feeder.jam_clamp_ext_ls.timeline.txt`), written by `tests/cli.test.ts`.
- `tests/equivalence.test.ts` runs the IR interpreter and the *generated ST* (through the
  test-only `tests/support/st-interpreter.ts`) side by side and compares outputs,
  `tj_state` and `tj_fault` every scan: each scenario, every device sensor jammed OFF/ON,
  and seeded random inputs. If the generator starts emitting new ST constructs, extend
  the ST interpreter (it throws on anything unsupported). Never weaken this test to make
  it pass: a mismatch means the simulator and the PLC code disagree.
- Golden-file tests for generated ST (`tests/golden/*.st`). Update goldens only on purpose, and say so.
  `tests/st.test.ts` also checks for every example that each output is assigned exactly
  once in the FUNCTION_BLOCK, that code outside comments is ASCII, and that blocks balance.
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
