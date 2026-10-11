#!/usr/bin/env bash
# Creates the one dev user the local Supabase stack needs (personal-use app, no
# real accounts). Idempotent: re-running when the user exists is a no-op.
# The admin key is read from the running local stack (`supabase status`), so
# nothing key-shaped lives in the repo. Never point this at the cloud project.
set -euo pipefail
cd "$(dirname "$0")/.."
LOCAL_URL="http://127.0.0.1:54321"
LOCAL_SECRET="$(supabase status -o env 2>/dev/null | sed -n 's/^SECRET_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1)"
if [ -z "$LOCAL_SECRET" ]; then
  echo "local Supabase stack is not running (supabase start), or the CLI printed no SECRET_KEY" >&2
  exit 1
fi
DEV_EMAIL="daniel@local.test"
DEV_PASSWORD="local-dev-only-2026"
code=$(curl -s -o /dev/null -w "%{http_code}" "$LOCAL_URL/auth/v1/admin/users" \
  -H "apikey: $LOCAL_SECRET" -H "Authorization: Bearer $LOCAL_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\",\"email_confirm\":true}")
case "$code" in
  200|201) echo "dev user created ($DEV_EMAIL)";;
  422)     echo "dev user already exists ($DEV_EMAIL)";;
  *)       echo "failed: HTTP $code"; exit 1;;
esac
