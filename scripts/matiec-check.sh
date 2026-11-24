#!/usr/bin/env bash
# Compile every generated .st file with matiec, then compile the C that
# matiec emits with gcc, the two steps OpenPLC Runtime runs on upload.
# Exits 1 if any file fails either step.
#
# Usage: scripts/matiec-check.sh <matiec-dir> <st-dir>
set -uo pipefail

matiec="${1:?usage: scripts/matiec-check.sh <matiec-dir> <st-dir>}"
st_dir="${2:?usage: scripts/matiec-check.sh <matiec-dir> <st-dir>}"
work="$(mktemp -d)"
failed=0

echo "matiec: $("$matiec/iec2c" -v 2>&1 | head -1), commit $(git -C "$matiec" rev-parse --short HEAD)"
echo "gcc:    $(gcc --version | head -1)"

shopt -s nullglob
files=("$st_dir"/*.st)
if [ ${#files[@]} -eq 0 ]; then
  echo "no .st files in $st_dir"
  exit 1
fi

for st in "${files[@]}"; do
  name="$(basename "$st" .st)"
  out="$work/$name"
  mkdir -p "$out"
  echo
  echo "=== $name.st"
  echo "\$ iec2c -I lib -T $name $name.st"
  if "$matiec/iec2c" -I "$matiec/lib" -T "$out" "$st"; then
    echo "iec2c: OK"
  else
    echo "iec2c: FAILED"
    failed=1
    continue
  fi
  echo "\$ gcc -c -I lib/C Config0.c Res0.c"
  if (cd "$out" && gcc -c -I "$matiec/lib/C" Config0.c Res0.c); then
    echo "gcc:   OK ($(cd "$out" && ls *.o | tr '\n' ' '))"
  else
    echo "gcc:   FAILED"
    failed=1
  fi
done

rm -rf "$work"
echo
if [ "$failed" -ne 0 ]; then
  echo "FAILED: generated Structured Text does not compile with matiec"
  exit 1
fi
echo "OK: all ${#files[@]} files compiled with matiec and gcc"
