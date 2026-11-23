# Tejun language reference

Tejun (手順, "procedure") programs one machine station: its sensors and
actuators, the safety rules between them, and the sequence it runs. The
compiler checks the program before anything runs, then generates IEC 61131-3
Structured Text. The formal grammar is in [`grammar.ebnf`](grammar.ebnf); every
error code is explained in [`checks.md`](checks.md).

## A complete program

```tejun
// Press feeder: clamp an incoming part, press it, release it.
station PressFeeder "プレス送り" {
  io {
    input  part_present : bool     @ %IX0.0  "ワーク検出"
    input  clamp_ext_ls : bool     @ %IX0.1  "クランプ前進端"
    input  clamp_ret_ls : bool     @ %IX0.2  "クランプ後退端"
    input  estop_ok     : bool     @ %IX0.7  "非常停止OK" safety
    output clamp_out    : bool     @ %QX0.0  "クランプ前進"
    output clamp_in     : bool     @ %QX0.1  "クランプ後退"
    output conveyor     : bool     @ %QX0.2  "搬送コンベア"
    input  press_force  : real<kN> @ %IW2    "プレス荷重" range 0..50
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

## Files, comments and names

- One file holds exactly one `station`. Files are UTF-8.
- `// comment` runs to the end of the line.
- Names (signals, devices, states, fault codes) use ASCII letters, digits and
  `_`, and start with a letter or `_`. Japanese text is allowed only inside
  `"strings"` and comments (a full-width `；` typed by an IME is reported with
  a hint, T0001).
- Keywords are reserved:
  `station io input output bool real safety range device interlock never
  requires else fault sequence state on hold when within forever outputs safe
  and or not`.
- Names also become Structured Text identifiers, so they cannot be ST reserved
  words (`step`, `time`, `do`, …), cannot start with `tj_`, and two names may
  not differ only in case (T0107).
- By convention fault codes are `UPPER_SNAKE` and states are `CapitalCase`.

## Station

```text
station <Name> ["label"] {
  io { … }               exactly one, first
  device …               zero or more
  interlock …            zero or more
  sequence <name> { … }  exactly one
  on …                   handlers, last
}
```

Sections must appear in this order (T0014). The label is free text, usually
Japanese, and appears in generated code comments.

## I/O

```text
input  part_present : bool     @ %IX0.0  "ワーク検出"
input  estop_ok     : bool     @ %IX0.7  "非常停止OK" safety
input  press_force  : real<kN> @ %IW2    "プレス荷重" range 0..50
output conveyor     : bool     @ %QX0.2  "搬送コンベア"
```

Each line is `input|output <name> : <type> @ <address> ["label"] [safety] [range a..b]`.

| Part | Rules |
|---|---|
| type | `bool`, or `real` with an optional unit: `real<kN>` |
| address | `%IX<byte>.<bit>` input bit, `%QX<byte>.<bit>` output bit (bit 0..7), `%IW<n>` input word, `%QW<n>` output word |
| address checks | inputs use `%I`, outputs `%Q` (T0302); `bool` uses bit addresses, `real` word addresses (T0303); no two signals share an address (T0301); `%QX9` or `%QX0.8` is a syntax error with a suggestion (T0003) |
| `safety` | marks an E-stop or guard input; only on `bool` inputs (T0306) |
| `range a..b` | for `real` signals; the expected value range in the signal's unit. Comparisons that can never change result over the range are errors (T0106). In generated code, a word input's raw 0..65535 is scaled to this range. |

Units: `N kN mm m bar kPa MPa degC rpm A V`. Units are case-sensitive and
never converted (`40 N` against a `kN` signal is T0104, with the converted value
suggested).

## Devices

```text
device clamp : Cylinder(extend: clamp_out, retract: clamp_in,
                        at_ext: clamp_ext_ls, at_ret: clamp_ret_ls)
```

`Cylinder` is a double-acting pneumatic cylinder with a limit switch at each end.
It is the only device kind for now.

| Parameter | Wired to | Meaning |
|---|---|---|
| `extend` | bool output | valve output that extends the cylinder |
| `retract` | bool output | valve output that retracts it |
| `at_ext` | bool input | sensor confirming it is extended |
| `at_ret` | bool input | sensor confirming it is retracted |

All four are required (T0402); each output may be driven by only one device
parameter (T0406). A cylinder offers:

- actions, used as a state's step: `clamp.extend`, `clamp.retract`
- states, used in conditions: `clamp.extended`, `clamp.retracted`

A device owns its outputs: switching `clamp_out on` directly is a double coil
and is rejected (T0406).

## Interlocks

| Form | Meaning | Checked |
|---|---|---|
| `interlock never <cond>` | `<cond>` must never hold | proved before running (T0203) |
| `interlock <output> requires <cond>` | `<output>` may be ON only while `<cond>` holds | proved before running (T0203) |
| `interlock <cond> else fault <CODE>` | `<cond>` must always hold, or the machine faults | runtime monitor, every scan |

```text
interlock never (clamp_out and clamp_in)
interlock conveyor requires clamp.retracted
interlock press_force < 40 kN else fault OVERLOAD
```

The proof explores every reachable state with every combination of inputs and
reports the shortest path to a violation. Device states like `clamp.retracted`
are judged from the device's last *confirmed* action and are unknown at startup,
so a station that needs a device position in its first state must home it first:

```text
state Home { clamp.retract within 2 s else fault HOME_TIMEOUT; -> Idle }
```

A station with more than 10 free inputs to explore is too large to prove (T0210).

## Sequence and states

```text
sequence main {
  state Idle  { conveyor on; when part_present forever -> Clamp }
  state Clamp { clamp.extend within 2 s else fault CLAMP_TIMEOUT; -> Press }
  …
}
```

The first state is where the machine starts. `Stopped` is built in: you never
declare it (T0102), and every output is OFF there.

A state contains, in this order:

1. **Outputs** switched on for the whole state: `conveyor on`. Outputs not
   mentioned are OFF; there is no `off`.
2. **At most one step** (T0208): a device action
   `clamp.extend within 2 s else fault CLAMP_TIMEOUT`, or `hold 1500 ms`.
   A device action drives its output for the whole state and finishes when its
   sensor confirms; `hold` finishes when its time is up.
3. **Transitions**, tried top to bottom once the step is done; the first true one
   is taken:
   - `when <cond> [timeout] -> <State>` waits for a condition
   - `-> <State>` goes unconditionally (nothing may follow it, T0207)

Statements are separated by `;` (T0016).

### Timeouts

Every wait needs a timeout, or an explicit `forever` (T0201):

```text
clamp.extend within 2 s else fault CLAMP_TIMEOUT    device action
when vacuum_ok within 500 ms else fault NO_VACUUM -> Lift
when part_present forever -> Clamp                  waiting forever on purpose
```

Times use `ms` or `s`. A `when` followed by a bare `-> S` is a branch, not a
wait, and needs no timeout:

```text
state Sense { when metal_sensor -> Push; -> Pass }
```

### Reachability

Every state must be reachable from the first state (T0202) and must have a way
out (T0206).

## Handlers

```text
on fault        { outputs safe; -> Stopped }
on not estop_ok { outputs safe; -> Stopped }
```

- `on not <safety input>` is required in every station (T0205). It is checked
  every scan, before the sequence.
- `on fault` is required if anything can raise a fault (T0204).
- Both must go to `Stopped` (T0209); the body is always `outputs safe; -> Stopped`.
- Safety inputs may be used in handlers and interlocks, but not in states (T0305),
  so the stop path stays independent of the sequence.

## Expressions

| Kind | Examples |
|---|---|
| signal | `part_present`, `conveyor` (an output reads its value from the previous scan) |
| device state | `clamp.retracted`, `z.extended` |
| number | `40`, `1.5`, `40 kN` |
| comparison | `<  <=  >  >=  ==  !=` (no chains like `0 < x < 40`, T0015) |
| logic | `not`, `and`, `or`, parentheses |

Precedence, lowest first: `or`, `and`, `not`, comparisons. Conditions must be
true/false (T0103); `<` and friends compare numbers with the same unit (T0104);
`==` and `!=` also compare bools.

## How a scan runs

The generated PLC code, the simulator and the interlock proof all follow the same
order every scan:

1. runtime monitors (`<cond> else fault`) and E-stop handlers
2. the current state: its step, or once the step is done its transitions
3. entering a new state resets its step and timer
4. every output is written once, from the state the scan ended in

## Tools

```text
tejun check <file>                       check and print diagnostics
tejun build <file> [-o dir]              write <dir>/<name>.st (default dir: out)
tejun run <file> [--scenario f] [--jam sensor[=on|off]] [--until 5s] [--scan 20ms]
```

`tejun run` uses `<name>.scenario` next to the program if present:

```text
# comment
at 1 s     part_present = on
at 2 s     press_force = 12 kN
follow vacuum_ok = vacuum after 100 ms
until 10 s
```
