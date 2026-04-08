#!/usr/bin/env bash
# Integration test for role-based peer ID persistence.
#
# Boots a broker against an isolated DB + port, drives the HTTP API directly
# with curl/jq-free shell, and verifies:
#
#   1. A peer claiming a role gets a fresh ID.
#   2. After the peer is unregistered (clean death), the row is retained as
#      dead and its role binding is reclaimable.
#   3. A new peer registering with the same role inherits the dead peer's ID.
#   4. A third peer attempting to claim the live role is rejected.
#   5. Role-less register continues to work.
#   6. set_role + reclaim roundtrip works.
#   7. A second distinct role gets its own fresh ID.
#
# Usage:  bash scripts/test-role-persistence.sh
# Exit:   0 on success, 1 on any assertion failure.

set -euo pipefail

PORT=${TEST_PORT:-7901}
DB=/tmp/claude-peers-role-test-$$.db
ROLE=test-role-$$
BROKER_PID=""

cleanup() {
  if [ -n "$BROKER_PID" ]; then
    kill -9 "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  rm -f "$DB" "$DB-wal" "$DB-shm"
}
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  pass: $1"; }

extract_id() {
  bun -e 'const b = JSON.parse(await Bun.stdin.text()); if (!b.id) { console.error("no id in", JSON.stringify(b)); process.exit(1); } console.log(b.id);'
}

post() {
  curl -s -X POST "http://127.0.0.1:$PORT$1" \
    -H 'Content-Type: application/json' -d "$2"
}

echo "boot broker on port $PORT, db $DB"
CLAUDE_PEERS_DB="$DB" CLAUDE_PEERS_PORT="$PORT" bun "$REPO_ROOT/broker.ts" &
BROKER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || fail "broker didn't come up"

echo "case 1: fresh role claim"
REG_A=$(post /register "{\"pid\":$$,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"A\",\"role\":\"$ROLE\"}")
A_ID=$(printf '%s' "$REG_A" | extract_id)
[ -n "$A_ID" ] || fail "A register: $REG_A"
pass "A registered as $A_ID with role=$ROLE"

echo "case 2: unregister A (mark dead)"
post /unregister "{\"id\":\"$A_ID\"}" >/dev/null
DEAD_STATUS=$(bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('$DB');
const row = db.query('SELECT status FROM peers WHERE id = ?').get('$A_ID');
console.log(row?.status ?? 'missing');
")
[ "$DEAD_STATUS" = "dead" ] || fail "A status after unregister: $DEAD_STATUS (expected dead)"
pass "A row retained as dead"

echo "case 3: reclaim"
REG_B=$(post /register "{\"pid\":$$,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"B reclaim\",\"role\":\"$ROLE\"}")
B_ID=$(printf '%s' "$REG_B" | extract_id)
[ "$A_ID" = "$B_ID" ] || fail "reclaim: A=$A_ID B=$B_ID"
pass "B reclaimed A's ID: $B_ID"

echo "case 4: live conflict rejected"
REG_C=$(post /register "{\"pid\":777001,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"C\",\"role\":\"$ROLE\"}")
printf '%s' "$REG_C" | grep -q "already held" || fail "expected live conflict, got: $REG_C"
pass "C rejected with live-conflict error"

echo "case 5: role-less register still works"
REG_D=$(post /register "{\"pid\":777002,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"D\"}")
D_ID=$(printf '%s' "$REG_D" | extract_id)
[ -n "$D_ID" ] || fail "D register: $REG_D"
pass "D (no role) registered as $D_ID"

echo "case 6: set_role + reclaim roundtrip"
REG_E=$(post /register "{\"pid\":777003,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"E\"}")
E_ID=$(printf '%s' "$REG_E" | extract_id)
E_ROLE="late-$$"
SET_E=$(post /set-role "{\"id\":\"$E_ID\",\"role\":\"$E_ROLE\"}")
printf '%s' "$SET_E" | grep -q '"ok":true' || fail "set_role E: $SET_E"
post /unregister "{\"id\":\"$E_ID\"}" >/dev/null
REG_F=$(post /register "{\"pid\":777004,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"F\",\"role\":\"$E_ROLE\"}")
F_ID=$(printf '%s' "$REG_F" | extract_id)
[ "$E_ID" = "$F_ID" ] || fail "set_role reclaim: E=$E_ID F=$F_ID"
pass "set_role → reclaim: $E_ID"

echo "case 7: distinct role gets fresh ID"
REG_G=$(post /register "{\"pid\":777005,\"cwd\":\"/tmp\",\"git_root\":null,\"tty\":null,\"summary\":\"G\",\"role\":\"other-$$\"}")
G_ID=$(printf '%s' "$REG_G" | extract_id)
[ "$G_ID" != "$A_ID" ] && [ "$G_ID" != "$E_ID" ] || fail "distinct role: G=$G_ID collided"
pass "distinct role got fresh ID: $G_ID"

echo
echo "all assertions passed"
