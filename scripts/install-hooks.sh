#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "[OK] Configured Git hooks path to .githooks in $(basename "${REPO_ROOT}")"
