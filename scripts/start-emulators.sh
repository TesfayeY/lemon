#!/usr/bin/env bash
# Start Firebase emulators for local development
set -euo pipefail

cd "$(dirname "$0")/../firebase"

echo "Starting Firebase emulators (Auth + Firestore)..."
firebase emulators:start --project lemon-dev
