#!/usr/bin/env bash
# Carrega o schema num Postgres local e roda os testes.
#
# A ordem importa: 02_storage usa a semente do 01_smoke (os walkers, o pricing e
# a versão dos termos) e carrega depois dele de propósito.
set -euo pipefail
cd "$(dirname "$0")/.."

docker exec quati-db psql -U postgres -d postgres -q \
  -c "drop database if exists quati;" -c "create database quati;" >/dev/null

for f in tests/00_stub_supabase.sql \
         supabase/migrations/0001_schema.sql \
         supabase/migrations/0002_rpc.sql \
         supabase/migrations/0003_storage.sql \
         tests/01_smoke.sql \
         tests/02_storage.sql; do
  docker exec -i quati-db psql -U postgres -d quati -v ON_ERROR_STOP=1 -q < "$f"
done
