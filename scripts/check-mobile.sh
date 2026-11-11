#!/usr/bin/env bash
# Run all mobile checks: analyzer and tests
set -euo pipefail

cd "$(dirname "$0")/../apps/mobile"

echo "=== Dependencies ==="
flutter pub get

echo ""
echo "=== Analyzer ==="
flutter analyze

echo ""
echo "=== Unit & widget tests ==="
flutter test

echo ""
echo "All mobile checks passed."
