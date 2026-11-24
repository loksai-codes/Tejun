#!/usr/bin/env bash
# Local version of the CI "plc-compile" job: regenerate the Structured Text
# for every example, then build matiec and compile the files in a clean
# ubuntu:24.04 container. Needs Docker and a prior `npm run build`.
# Works in Git Bash on Windows as well as on Linux/macOS.
#
# Usage: bash scripts/matiec-docker.sh
set -euo pipefail

cd "$(dirname "$0")/.."
rm -rf out/st
for f in examples/*.tejun; do
  npx tejun build "$f" -o out/st
done

# Git Bash: give Docker a Windows path and stop MSYS rewriting /repo.
repo="$(pwd -W 2>/dev/null || pwd)"
MSYS_NO_PATHCONV=1 docker run --rm -v "$repo:/repo:ro" ubuntu:24.04 bash -c '
  set -e
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    build-essential bison flex autoconf automake git >/dev/null 2>&1
  bash /repo/scripts/build-matiec.sh /opt/matiec
  bash /repo/scripts/matiec-check.sh /opt/matiec /repo/out/st'
