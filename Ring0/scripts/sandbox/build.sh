#!/usr/bin/env bash
# Builds the sandbox image used by the other Ring0 scripts. Needs network access once.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker build --tag "${RING0_SANDBOX_IMAGE:-emerald-selfhost-sandbox}" "$DIR"
