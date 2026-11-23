# Tejun for ladder engineers (ラダー技術者のための Tejun)

If you write ladder logic every day, you already know everything Tejun does.
Tejun writes the same machine logic as a list of steps (工程), and the compiler
checks the mistakes you normally find during commissioning (立ち上げ) — before
the program ever reaches the PLC. It then generates IEC 61131-3 Structured Text
that OpenPLC or CODESYS can load.

## The same ideas, different notation

| In ladder (ラダー) | In Tejun |
|---|---|
| I/O assignment list (I/O割付表) | the `io { … }` block: name, type, address, label |
| device comments (デバイスコメント) | the `"label"` after the address, shown in generated code |
| step relays with self-holding circuits (自己保持回路 / 工程歩進) | `state` blocks in a `sequence`; the current state *is* the step |
| output coil (出力コイル) | `conveyor on` inside a state |
| double coil (二重コイル) | impossible: each output is assigned once per scan from the state (T0406) |
| on-delay timer (TON / オンディレイタイマ) | `hold 1500 ms`, or the timeout of a wait |
| error-detection timer (異常検出タイマ) | `within 2 s else fault CLAMP_TIMEOUT` |
| cylinder with two limit switches (シリンダ + リミットスイッチ) | `device clamp : Cylinder(extend:…, retract:…, at_ext:…, at_ret:…)` |
| interlock contacts in series (インターロック接点) | `interlock conveyor requires clamp.retracted` — *proved*, not just wired |
| origin return (原点復帰) | a `Home` state at the start of the sequence |
| emergency stop circuit (非常停止回路) | a `safety` input and `on not estop_ok { outputs safe; -> Stopped }` |
| alarm number (アラーム番号) | the fault code; generated code exposes it as `tj_fault` |

## One step, side by side

A typical clamp step in ladder: the step relay holds itself, drives the valve,
starts an error timer, and advances when the forward limit switch confirms.

```text
  M101 (Idle)   X000 (part)                                 M102 (Clamp)
 ──┤ ├─────────┤ ├──────────────────────────────┬──────────────( )──
  M102 (Clamp)  M103 (Press)                    │
 ──┤ ├─────────┤/├──────────────────────────────┘
  M102                                                       Y000 (clamp out)
 ──┤ ├───────────────────────────────────────────────────────( )──
  M102          X001 (clamp ext LS)                          T102  K20
 ──┤ ├─────────┤/├───────────────────────────────────────────(TON)─
  T102                                                       M900 (CLAMP_TIMEOUT)
 ──┤ ├───────────────────────────────────────────────────────(SET)─
  M102          X001                                         M103 (Press)
 ──┤ ├─────────┤ ├───────────────────────────────────────────( )── …
```

The same step in Tejun is one line:

```tejun
state Clamp { clamp.extend within 2 s else fault CLAMP_TIMEOUT; -> Press }
```

Tejun writes the self-holding, the coil, the timer and the alarm for you, and
always the same way.

## What the compiler catches before commissioning

These are the problems that usually appear on the shop floor. Tejun reports
them at your desk, with the line, a hint, and the message in Japanese.

- **Double coils (二重コイル).** An output can only be decided in one place. If a
  device drives `clamp_out`, writing `clamp_out on` yourself is an error (T0406).
- **Interlocks that can be violated.** Tejun tries every reachable step with every
  combination of inputs. If the conveyor could run while the clamp is not confirmed
  retracted, it shows you the exact path of steps that gets there (T0203).
- **Missing origin return (原点復帰).** At power-up Tejun does not know where a
  cylinder is. If your first step needs the clamp retracted, the proof asks you to
  home it first:

  ```tejun
  state Home { clamp.retract within 2 s else fault HOME_TIMEOUT; -> Idle }
  ```

- **Waits without an error timer.** Every wait for a sensor needs a timeout, or an
  explicit `forever` when waiting is the point, like waiting for the next part (T0201).
- **Steps you can never reach, or never leave** (T0202, T0206).
- **I/O mistakes:** an input on a `%Q` address, two signals on one address, an
  E-stop used inside the sequence instead of the stop circuit (T03xx).
- **Unit mistakes:** comparing `press_force` in kN with `40 N` (T0104).

The full list is in [`checks.md`](checks.md).

## How the generated program runs

Every scan does the same four things, in the same order, as the simulator and the
proof:

1. Check the runtime monitors and the E-stop.
2. Run the current step: wait for its sensor or timer, then try its transitions.
3. On entering a new step, reset its timer.
4. Write every output once, from the current step.

In the generated Structured Text the steps become a `CASE` statement, the error
timer is one `TON`, and outputs are plain assignments at the end:

```text
clamp_out := (tj_state = 3); (* Clamp *)
clamp_in := (tj_state = 1) OR (tj_state = 5); (* Home, Release *)
conveyor := (tj_state = 2); (* Idle *)
```

`tj_state` (current step) and `tj_fault` (alarm number) are outputs of the
function block, so an HMI can show them.

## Things to know

- One station per file; multi-station lines are not supported yet.
- The only device kind is the double-acting `Cylinder`.
- Tejun does not produce ladder diagrams; it produces Structured Text.
- Tejun is a development aid. It does not replace a certified safety PLC or a
  hard-wired emergency stop circuit, and makes no claim of safety certification.
