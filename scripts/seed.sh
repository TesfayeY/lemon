#!/usr/bin/env bash
# Seed fictional development profiles into local MongoDB (never production)
set -euo pipefail

cd "$(dirname "$0")/../apps/api"

: "${MONGO_URI:=mongodb://localhost:27017/?replicaSet=rs0}"
: "${FIREBASE_PROJECT_ID:=lemon-dev}"
: "${FIREBASE_AUTH_EMULATOR_HOST:=127.0.0.1:9099}"
: "${FIRESTORE_EMULATOR_HOST:=127.0.0.1:8080}"
export MONGO_URI FIREBASE_PROJECT_ID FIREBASE_AUTH_EMULATOR_HOST FIRESTORE_EMULATOR_HOST

npm run seed
