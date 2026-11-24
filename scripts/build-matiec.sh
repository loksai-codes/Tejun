#!/usr/bin/env bash
# Build matiec (iec2c), the IEC 61131-3 compiler used by OpenPLC Runtime,
# from OpenPLC's fork at a pinned commit.
#
# Usage: scripts/build-matiec.sh <dest-dir>
# Needs: git, gcc/g++, make, bison, flex, autoconf, automake.
set -euo pipefail

MATIEC_REPO="https://github.com/thiagoralves/matiec.git"
MATIEC_COMMIT="75d6e82cce5bc8b98ce03a417b106884cbb7ebb5"

dest="${1:?usage: scripts/build-matiec.sh <dest-dir>}"

if [ -x "$dest/iec2c" ] && [ "$(git -C "$dest" rev-parse HEAD 2>/dev/null)" = "$MATIEC_COMMIT" ]; then
  echo "matiec $MATIEC_COMMIT already built in $dest"
  exit 0
fi

rm -rf "$dest"
git clone --quiet "$MATIEC_REPO" "$dest"
git -C "$dest" -c advice.detachedHead=false checkout --quiet "$MATIEC_COMMIT"
cd "$dest"
autoreconf -i >/dev/null 2>&1
./configure >/dev/null
make -j"$(nproc)" >/dev/null 2>&1
echo "built matiec $MATIEC_COMMIT in $dest"
