#!/usr/bin/env bash
# Run all API checks: typecheck, lint, and tests
set -euo pipefail

cd "$(dirname "$0")/../apps/api"

echo "=== TypeScript type check ==="
npx tsc --noEmit

echo ""
echo "=== Unit & integration tests ==="
npx vitest run

echo ""
echo "All API checks passed."
