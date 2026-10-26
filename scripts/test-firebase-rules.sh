#!/usr/bin/env bash
# Run Firestore security rules tests against the emulator (needs a Java runtime)
set -euo pipefail

cd "$(dirname "$0")/../firebase"

# Homebrew's openjdk is keg-only; use it when no java is on PATH
if ! java -version >/dev/null 2>&1 && [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
  export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
fi

[ -d node_modules ] || npm ci

echo "=== Firestore rules tests ==="
npm run test:rules
