# Verifying the generated Structured Text with matiec

The Structured Text that `tejun build` generates is compiled with **matiec**
(`iec2c`), the IEC 61131-3 compiler inside OpenPLC Runtime. CI does this on
every push, for every example. The C code that matiec emits is then compiled
with gcc, the same two steps OpenPLC Runtime runs when you upload a program.

## What is checked, and what is not

| Checked (on every push, and locally with Docker) | Not checked |
|---|---|
| `iec2c` parses and type-checks each generated `.st` file and emits C | Linking and running the program inside OpenPLC Runtime |
| gcc compiles that C (`Config0.c`, `Res0.c`) against matiec's `lib/C` headers | Uploading through the OpenPLC web interface |
| | CODESYS, Omron Sysmac Studio, Mitsubishi GX Works3 (see [Portability](#portability)) |

Whether the program *behaves* correctly is checked separately:
`tests/equivalence.test.ts` runs the generated ST next to the simulator scan by
scan. That test uses Tejun's own ST interpreter, not matiec.

## Versions used

| Tool | Version |
|---|---|
| matiec | OpenPLC's fork, [`thiagoralves/matiec`](https://github.com/thiagoralves/matiec), commit `75d6e82cce5bc8b98ce03a417b106884cbb7ebb5` (5 Nov 2025); `iec2c -v` prints `matiec version 0.1` |
| gcc | `gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` |
| bison / flex | GNU Bison 3.8.2 / flex 2.6.4 |
| OS | `ubuntu:24.04` Docker image (locally, Docker 29.5.3 on Windows 11); `ubuntu-24.04` runner in CI |

matiec is built from source at that pinned commit by
[`scripts/build-matiec.sh`](../scripts/build-matiec.sh). To move to a newer
matiec, change `MATIEC_COMMIT` there; the CI cache key follows the script.

## Commands

Locally, with Docker (Git Bash on Windows, or Linux/macOS):

```sh
npm install
npm run build
bash scripts/matiec-docker.sh
```

[`scripts/matiec-docker.sh`](../scripts/matiec-docker.sh) regenerates
`out/st/<example>.st` for every file in `examples/`, then in a clean
`ubuntu:24.04` container installs `build-essential bison flex autoconf automake git`,
builds matiec and runs [`scripts/matiec-check.sh`](../scripts/matiec-check.sh).
For each file that script runs:

```sh
iec2c -I <matiec>/lib -T <outdir> <example>.st        # ST -> C
cd <outdir> && gcc -c -I <matiec>/lib/C Config0.c Res0.c   # C -> object files
```

and exits 1 if any step fails. CI runs the same scripts in the `plc-compile`
job of [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (on the runner
directly, without Docker).

## Output

The log from `bash scripts/matiec-docker.sh` on 24 Nov 2026, after the Motor
device kind and `examples/press_station.tejun` were added (exit code 0). The
three `missing` / `configure` lines are printed by matiec's own build and are
harmless.

```text
wrote out/st/conveyor_sorter.st
wrote out/st/pick_place.st
wrote out/st/press_feeder.st
wrote out/st/press_station.st
/opt/matiec/config/missing: Unknown `--is-lightweight' option
Try `/opt/matiec/config/missing --help' for more information
configure: WARNING: 'missing' script is too old or missing
built matiec 75d6e82cce5bc8b98ce03a417b106884cbb7ebb5 in /opt/matiec
matiec: matiec version 0.1, commit 75d6e82
gcc:    gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0

=== conveyor_sorter.st
$ iec2c -I lib -T conveyor_sorter conveyor_sorter.st
POUS.c
POUS.h
LOCATED_VARIABLES.h
VARIABLES.csv
Config0.c
Config0.h
Res0.c
iec2c: OK
$ gcc -c -I lib/C Config0.c Res0.c
gcc:   OK (Config0.o Res0.o )

=== pick_place.st
$ iec2c -I lib -T pick_place pick_place.st
POUS.c
POUS.h
LOCATED_VARIABLES.h
VARIABLES.csv
Config0.c
Config0.h
Res0.c
iec2c: OK
$ gcc -c -I lib/C Config0.c Res0.c
gcc:   OK (Config0.o Res0.o )

=== press_feeder.st
$ iec2c -I lib -T press_feeder press_feeder.st
POUS.c
POUS.h
LOCATED_VARIABLES.h
VARIABLES.csv
Config0.c
Config0.h
Res0.c
iec2c: OK
$ gcc -c -I lib/C Config0.c Res0.c
gcc:   OK (Config0.o Res0.o )

=== press_station.st
$ iec2c -I lib -T press_station press_station.st
POUS.c
POUS.h
LOCATED_VARIABLES.h
VARIABLES.csv
Config0.c
Config0.h
Res0.c
iec2c: OK
$ gcc -c -I lib/C Config0.c Res0.c
gcc:   OK (Config0.o Res0.o )

OK: all 4 files compiled with matiec and gcc
```

## The bug matiec found

The first time the examples went through matiec, **all three failed**. The
`PROGRAM` declared its I/O variables (`x AT %IX0.0 : BOOL`) and the block
instance (`tj_station : PressFeeder`) in the same `VAR` block. IEC 61131-3
keeps located variable declarations in their own block, and matiec enforces
that. The output for `press_feeder.st` before the fix (line 136 is the last
`AT` declaration; the errors after it follow from the first one):

```text
=== press_feeder.st
$ iec2c -I lib -T press_feeder press_feeder.st
/repo/out/old/press_feeder.st:136: error: invalid located variable declaration.
/repo/out/old/press_feeder.st:138: error: invalid variable before ':=' in ST assignment statement.
/repo/out/old/press_feeder.st:139: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:139: error: invalid variable before ':=' in ST assignment statement.
/repo/out/old/press_feeder.st:140: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:140: error: invalid variable before ':=' in ST assignment statement.
/repo/out/old/press_feeder.st:141: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:141: error: invalid variable before ':=' in ST assignment statement.
/repo/out/old/press_feeder.st:142: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:142: error: invalid variable before ':=' in ST assignment statement.
/repo/out/old/press_feeder.st:143: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:143: error: invalid statement in ST statement.
/repo/out/old/press_feeder.st:144: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:144: error: invalid statement in ST statement.
/repo/out/old/press_feeder.st:145: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:145: error: invalid statement in ST statement.
/repo/out/old/press_feeder.st:146: error: ';' missing at the end of statement in ST statement.
/repo/out/old/press_feeder.st:146: error: invalid statement in ST statement.

18 error(s) found. Bailing out!
iec2c: FAILED
```

`conveyor_sorter.st` (20 errors, from line 137) and `pick_place.st` (26 errors,
from line 190) failed the same way. The fix in `codegen/st.ts` puts the `AT`
variables and `tj_station` in two `VAR` blocks:

```text
    tj_raw_press_force AT %IW2 : UINT; (* press_force, raw 0..65535 *)
  END_VAR
  VAR
    tj_station : PressFeeder;
  END_VAR
```

The regression test in `tests/st.test.ts` ("located (AT) and ordinary
variables never share a VAR block") checks every example's generated ST for
this, so it is caught by `npm test` even without matiec.

## Portability

Only matiec has been run. The notes below come from the IEC 61131-3 standard
and from how these tools are usually set up. **None of them has been tried in
CODESYS, Sysmac Studio or GX Works3**, so treat them as a checklist for a first
import, not as results.

The `FUNCTION_BLOCK` is the portable part: it uses only `BOOL`, `INT`, `REAL`,
`TON`, `IF`, `CASE`, `T#…ms` literals and named-argument calls. The `PROGRAM`
and `CONFIGURATION` are written for OpenPLC.

| Construct in the generated file | Why it is there | Elsewhere |
|---|---|---|
| `CONFIGURATION Config0` / `RESOURCE Res0 ON PLC` / `TASK task0(INTERVAL := T#20ms, …)` | OpenPLC Runtime expects a configuration in the uploaded file; `PLC` is the resource type name matiec/OpenPLC use | CODESYS, Sysmac Studio and GX Works3 set up tasks in the project tree, not in ST text. Leave this part out. |
| Direct addresses `%IX0.0`, `%QX0.0`, `%IW2` in the `PROGRAM` | OpenPLC's address layout | CODESYS maps addresses through the device's I/O mapping; Sysmac Studio assigns I/O to variables in its I/O Map; GX Works3 uses device names such as `X0`/`Y0`/`D0`. Copy the `FUNCTION_BLOCK` and connect its inputs and outputs in the tool. |
| `AT` variables in a `VAR` block of their own | Required by matiec (see above); this is the standard's form | Expected to be accepted elsewhere; not tried. |
| Analog input scaled from `UINT` 0..65535: `UINT_TO_REAL(raw) * 50.0 / 65535.0` | OpenPLC's `%IW` range | Real analog modules use other raw ranges. Change the scaling in the `PROGRAM`, or pass engineering units straight into the block. Check that the tool has `UINT_TO_REAL` under that name. |
| One `TON` instance, reset with `tj_timer(IN := FALSE)` without `PT` | The standard keeps a block's last input values between calls | `TON` is a standard block; check the tool's timer block and its time resolution. |
| `VAR_OUTPUT` with initial values (`tj_state : INT := 1`) | State starts in the first state | Standard; not tried elsewhere. |
| UTF-8 Japanese text in comments | Labels from the `.tejun` source | matiec accepted it. Other tools may expect another text encoding on import; code outside comments is plain ASCII (checked in `tests/st.test.ts`). |
