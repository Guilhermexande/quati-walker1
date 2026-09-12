#!/usr/bin/env bash
# Carrega o schema num Postgres local e roda os testes de fumaça.
set -euo pipefail
cd "$(dirname "$0")/.."

docker exec quati-db psql -U postgres -d postgres -q \
  -c "drop database if exists quati;" -c "create database quati;" >/dev/null

for f in tests/00_stub_supabase.sql \
         supabase/migrations/0001_schema.sql \
         supabase/migrations/0002_rpc.sql \
         tests/01_smoke.sql; do
  docker exec -i quati-db psql -U postgres -d quati -v ON_ERROR_STOP=1 -q < "$f"
done
