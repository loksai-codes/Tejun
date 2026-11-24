# What the interlock proof guarantees, and what it assumes

Tejun checks interlocks in two ways:

- **Proved before the program runs:** `interlock never <cond>` and
  `interlock <output> requires <cond>` (error T0203 if they can fail).
- **Guarded at runtime, every scan:** `interlock <cond> else fault <CODE>`, the
  E-stop handler, action timeouts, and the **device check**
  (`POSITION_MISMATCH` for a Cylinder, `FEEDBACK_MISMATCH` for a Motor).

This page says exactly what the proof promises, under which assumptions, and
where the runtime guards take over. The proof is in
[`checker/interlocks.ts`](../packages/compiler/src/checker/interlocks.ts).

## The guarantee

> For **every** sequence of input values, where any input may take any value in
> any scan and any timer may expire in any scan, the outputs the program writes
> at the end of every scan satisfy every `never` and `requires` interlock. In
> those interlocks a device state such as `clamp.retracted` or `belt.stopped`
> means the device's **tracked state** (below), not its physical state.

When the proof cannot establish this, the program is rejected with the shortest
path to a violation, so no Structured Text is generated.

Two things to notice:

1. The proof does **not** assume the sensors tell the truth. Inputs are free:
   any sensor can read anything, independently in every scan. A broken sensor
   cannot make the program break a proved interlock *as the program sees it*.
2. What a broken sensor *can* do is make the tracked state wrong. That gap,
   between where the program thinks a cylinder is (or whether a motor has
   stopped) and the real machine, is closed at runtime by the device check, not
   by the proof.

## The model the proof explores

A breadth-first search over configurations:

| Part of a configuration | Values |
|---|---|
| state | each declared state, or `Stopped` |
| step | still running, or done (then the transitions are tried) |
| each device's tracked state | Cylinder: `unknown`, `moving`, `extended`, `retracted`; Motor: `unknown`, `moving`, `running`, `stopping`, `stopped` |

Per scan, from each configuration, it tries every combination of:

- **Free inputs.** Each bool input the logic reads, each device step's done
  sensor, each motor's feedback, and each distinct comparison on a real input
  (such as `press_force < 40 kN`) is one free true/false value.
- **The state's timer**, which is either done or not done.

### Tracked states

- At startup every device is `unknown`. The exception is the device whose action
  is the first state's step: it is `moving`.
- Entering a state whose step is an action of a device marks that device
  `moving`.
- When the action's done sensor is ON in a scan where the step runs, the device
  takes the action's state (`extended` / `retracted` / `running`).
- A cylinder keeps that state until its next action.
- A motor runs only in states whose step is its `run`. Entering any other state
  (including `Stopped`) makes a `moving` or `running` motor `stopping`. At the
  start of a later scan in which its feedback is OFF, it becomes `stopped`. An
  `unknown` motor becomes `stopped` the same way.
- `clamp.retracted` is true only while the tracked state is `retracted`, and
  `belt.stopped` only while it is `stopped`. An `unknown`, `moving` or
  `stopping` device satisfies none of its states. This is why a station whose
  first state needs a position must home the device first (the `Home` state in
  the examples), and why a press must wait for `belt.stopped` after the belt was
  switched off (`Settle` in `examples/press_station.tejun`; without it the proof
  reports T0203: "`belt` may still be stopping in `Press`").

A device's outputs can only be driven by its actions (double coils are rejected,
T0406). So in a program that checks clean, nothing else moves a device.

### Scan cycle

The proof, the generated Structured Text and the simulator use the same order
every scan:

1. a stopping (or unknown) motor whose feedback is OFF becomes `stopped`; then
   runtime monitors (`<cond> else fault`), the device check, and E-stop
   handlers. Any of these may stop the machine.
2. the current state: its step, or, once the step is done, its transitions
   (top to bottom, first true wins)
3. entering a new state: reset the step and its timer, mark its device moving,
   and make every motor it does not run `stopping`
4. write every output once, from the state the scan ended in

Each interlock is checked against the state a scan **ends** in, together with
the inputs that scan **read**. A step completes in one scan, and its transitions
are tried from the next scan. In `Stopped` every output is OFF.

### Timers

The proof ignores durations: in every scan, every running timer may or may not
have expired. So no part of the proof depends on a timeout value or the scan
time.

At runtime (generated ST and simulator alike) there is one IEC 61131-3 `TON`
per station for steps and waits, plus one per device for the device check.
`Q` turns on in the first scan in which the elapsed time has reached `PT`.
Times are measured at scan boundaries, which has two consequences:

- A step's timeout starts in the first scan *after* the state is entered. With
  20 ms scans, `within 2 s` faults 2.02 s after entering the state (see
  `CLAMP_TIMEOUT` at 3.020 s after `Idle -> Clamp` at 1.000 s in the README).
- A timeout can be up to one scan late if `PT` is not a multiple of the scan time.

The simulator's `TON` ([`runtime/src/timer.ts`](../packages/runtime/src/timer.ts))
was written to match the IEC/matiec on-delay timer. That is **not** checked
against matiec at runtime: the ST interpreter used by `tests/equivalence.test.ts`
reuses the same `TON` class, and the [matiec check](plc-verification.md) only
compiles the code.

### Real-valued inputs

Each comparison on a real input is a free bool, independent of every other
comparison. So `force < 30 kN` and `force < 40 kN` can be "false and true" in
the model even though that is impossible. This only adds behaviours, so the
proof can report a violation that cannot really happen (a false alarm). It
cannot miss one.

### The 10-input limit

The search tries every combination of free inputs, 2ⁿ per scan. Above 10 free
inputs, Tejun refuses to prove and reports **T0210**. A station that large is
rejected; it is never accepted unproved.

## What "proved" does not cover

Assumptions outside the model, each stated plainly:

| Assumption | What breaks if it does not hold |
|---|---|
| The PLC runs the generated code with the scan semantics above: inputs read before the scan, outputs written after it | The proof's scan order no longer matches. The ST compiles with matiec ([logs](plc-verification.md)), but has not been run inside OpenPLC Runtime. |
| Between two scans, outputs keep their values | An interlock that reads an input (`never (belt and door_open)`) can be violated on the real machine for up to one scan plus I/O delay after the input changes. The proof is about scan boundaries. |
| With both valve outputs OFF a cylinder holds its position (double-acting, double-solenoid or closed-centre valve) | With a spring-return valve the cylinder moves on its own when the output drops. The position check would then raise `POSITION_MISMATCH`. |
| A motor's feedback is OFF only at standstill (a speed monitor) | With a contactor's auxiliary contact as feedback, `stopped` is confirmed as soon as the contactor drops out, while the motor may still be coasting. `belt.stopped` is only as true as the feedback it is read from. |
| The tracked state matches the real one | This is what the device check guards, below. |
| `<cond> else fault` monitors | Not proved. They stop the machine in the first scan in which they read false. |
| The E-stop | Tejun is a development aid, not a safety system. E-stop must be hard-wired and handled by a safety PLC or relay. |

## The device check: closing the gap at runtime

Every scan, outside `Stopped`, each device's sensors are compared with its
tracked state. They **disagree** when any of these holds:

| Device | Condition | Typical cause |
|---|---|---|
| Cylinder | both end sensors are ON | a sensor stuck ON, or wiring fault |
| Cylinder | tracked at an end, and that end's sensor is OFF | pushed by hand, sensor failed OFF, cable cut |
| Cylinder | moving away from an end, and that end's sensor is still ON | the sensor at the start position is stuck ON |
| Motor | tracked `running`, and the feedback is OFF | **feedback lost**: tripped overload, broken belt or coupling, sensor failed |
| Motor | tracked `stopped`, and the feedback is ON | the motor started by itself: welded contactor, local start, a drive fault |

The conditions come from one rule, applied to each kind's definition in
[`device-kinds.ts`](../packages/compiler/src/device-kinds.ts): each device state
is "this input has this value". The check fires when two states on different
inputs hold at once, when the tracked state's input says otherwise, or when the
device is moving away from a state that still holds. A motor's two states share
one input, so only the middle rule applies to it. A motor starting up is covered
by its start-feedback timeout instead.

If a disagreement lasts **100 ms** (`MISMATCH_DEBOUNCE_MS`, fixed), the machine
raises the device's fault: `on fault` runs and every output is OFF in `Stopped`.
The check can only stop the machine. Every station must have an E-stop handler,
so the proof already explores "stop in any scan", and adding the check cannot
invalidate a proof.

Generated Structured Text for one cylinder (from `tests/golden/press_feeder.st`):

```text
    (* position check: clamp sensors must agree with its tracked position *)
    tj_mismatch_clamp(
      IN := (clamp_ext_ls AND clamp_ret_ls)
        OR (tj_pos_clamp = 2 AND NOT clamp_ext_ls)
        OR (tj_pos_clamp = 3 AND NOT clamp_ret_ls)
        OR (tj_pos_clamp = 1 AND tj_from_clamp = 2 AND clamp_ext_ls)
        OR (tj_pos_clamp = 1 AND tj_from_clamp = 3 AND clamp_ret_ls),
      PT := T#100ms);
    IF tj_fault = 0 AND tj_mismatch_clamp.Q THEN
      tj_fault := 5; (* POSITION_MISMATCH *)
    END_IF;
```

The same for a motor, with its release (from `tests/golden/press_station.st`):

```text
    (* belt: stopped once NOT belt_fb *)
    IF (tj_pos_belt = 0 OR tj_pos_belt = 4) AND NOT belt_fb THEN
      tj_pos_belt := 3; (* stopped *)
    END_IF;
    ...
    (* state check: belt sensors must agree with its tracked state *)
    tj_mismatch_belt(
      IN := (tj_pos_belt = 2 AND NOT belt_fb)
        OR (tj_pos_belt = 3 AND belt_fb),
      PT := T#100ms);
    IF tj_fault = 0 AND tj_mismatch_belt.Q THEN
      tj_fault := 13; (* FEEDBACK_MISMATCH *)
    END_IF;
    ...
    (* belt is stopping in every state that does not drive it *)
    IF tj_state <> 3 AND tj_state <> 9 AND (tj_pos_belt = 1 OR tj_pos_belt = 2) THEN
      tj_pos_belt := 4; (* stopping *)
    END_IF;
```

A sensor stuck ON, from `npx tejun run examples/conveyor_sorter.tejun --jam pusher_ret_ls=on`:

```text
  1.000  Run -> Sense                       outputs: all OFF
  1.020  Sense -> Push                      outputs: pusher_out
  1.100  part_at_gate OFF (scenario)
  1.100  metal_sensor OFF (scenario)
  1.140  FAULT 5 POSITION_MISMATCH: pusher sensors (pusher_ext_ls OFF, pusher_ret_ls ON) disagree with its tracked position (moving from retracted) for 100 ms
  1.140  Push -> Stopped                    outputs: all OFF
end at 1.140 s: Stopped, fault POSITION_MISMATCH
```

Without the third condition, this run would have let `Back` "complete" at once
on the stuck sensor. The belt would then have restarted with the pusher left
mid-stroke across it. We checked once, by hand, that removing the condition
makes this case fail in `tests/equivalence.test.ts`. That check is not part of
the test suite.

### What the tests measure

`tests/equivalence.test.ts` runs every device of every example in the
simulator, through the generated ST alongside, and compares outputs, state and
fault every scan:

| Device | Case | Result in every example |
|---|---|---|
| all | healthy scenario | never raises a device fault; no interlock violated on the real (simulated) machine |
| Cylinder | end sensor stuck ON | `POSITION_MISMATCH` at most one travel time (300 ms) + 100 ms after the real machine first contradicts the sensor |
| Cylinder | end sensor stuck OFF from startup | the action's timeout (e.g. `CLAMP_TIMEOUT`), not a mismatch |
| Cylinder | sensor of the end it rests at fails OFF | `POSITION_MISMATCH` exactly 100 ms later |
| Cylinder | pushed by hand to the other end, or to mid-stroke | `POSITION_MISMATCH` exactly 100 ms later |
| Cylinder | sensor glitch of 60 ms | ignored |
| Motor | feedback stuck OFF from startup | the start-feedback timeout (`BELT_NO_START`), not a mismatch |
| Motor | feedback stuck ON from startup | standstill is never confirmed, so nothing that requires `belt.stopped` runs; no real-world violation (the run ends in `BELT_NO_STOP`) |
| Motor | feedback lost while running | `FEEDBACK_MISMATCH` exactly 100 ms later |
| Motor | feedback comes on while stopped | `FEEDBACK_MISMATCH` exactly 100 ms later |
| Motor | feedback glitch of 60 ms while running | ignored |

In every case the runtime's own re-check of the proved interlocks (on tracked
states) never fires. The tests also evaluate each `never`/`requires`
interlock on the simulated machine's **actual** cylinder positions and motor
speeds (`stopped` = standstill, `running` = full speed). Real-world
violations occur only between the disturbance and the fault, never before or
after. For example, a press-feeder clamp pushed out by hand while the conveyor
runs gives 5 scans (100 ms) of `conveyor` ON with the clamp not retracted, then
the machine stops.

### What the device check cannot catch

- **For up to 100 ms, by design.** During the debounce time the outputs stay as
  they were, so a real interlock can be violated for that long (above).
- **A lie that agrees with the tracked position.** If a device is moved while
  its sensors keep reporting the tracked end, no sensor logic can see it. Cases:
  both sensors fail consistently; the wiring of the two sensors is swapped; the
  device moves so little that its end switch never releases.
- **Homing onto a stuck sensor.** A move from `unknown` has no known start, so
  there is no departure check. If a cylinder is mid-stroke at power-on and the
  sensor it homes to is stuck ON, homing "completes" at once. We ran this:
  press feeder, clamp at half stroke, `clamp_ret_ls` stuck ON. `Home -> Idle`
  happens at 0.020 s and the conveyor runs for 980 ms with the clamp not
  retracted. The next move (`Clamp`, departure check) raises `POSITION_MISMATCH`
  at 1.120 s. Two end switches cannot tell "already home" from "stuck sensor" at
  that moment. Closing this needs a language change (for example, a minimum
  drive time for homing moves), which Tejun does not have yet.
- **While moving.** During a move only "both ON" and the departure condition are
  checked. A cylinder that stops halfway is caught by the action's timeout,
  unless the action says `forever`.
- **A slow start.** The departure condition expects a cylinder to leave its end
  switch within 100 ms of its valve switching. A slow cylinder could trip it
  falsely. The debounce time is one fixed constant for every device; making it
  configurable per device is not implemented.
- **A motor that runs, but wrongly.** The feedback is one bit. A belt that
  slips, runs slowly or runs backwards with its feedback ON looks healthy.
- **A motor's stuck-ON feedback at startup.** The motor never becomes `stopped`
  (above), which is safe for interlocks that require it. But a station that never
  waits for `belt.stopped` will not notice the stuck feedback at all.
- **Device kinds other than `Cylinder` and `Motor`.** They do not exist yet.

## Summary

| | Proved before running | Guarded at runtime |
|---|---|---|
| `never`, `requires` interlocks | yes, on tracked positions, for all inputs | re-checked every scan (reports only) |
| tracked state = real state | no | device check: stops within 100 ms, except the cases above |
| `<cond> else fault` | no | every scan |
| waits and moves that never finish | every wait has a timeout or says `forever` (T0201) | timeouts, every scan |
| E-stop | a handler exists and goes to `Stopped` (T0205, T0209) | every scan; not a safety function |
