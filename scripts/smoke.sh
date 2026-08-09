#!/usr/bin/env bash
set -euo pipefail

# Every documented command end-to-end against a throwaway HOME and empty
# session stores. Launch paths only ever run with --dry-run, so the smoke
# can never start a real harness.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Raw launch grammar: balancing off, exactly what the harness receives.
run() {
  env -i PATH="$PATH" HOME="$WORK/home" AGENTSURFACE_NO_BALANCE=1 \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" PI_CODING_AGENT_DIR="$WORK/pi" \
    bun "$ROOT/src/main.ts" "$@"
}

# Balanced grammar: a fake agentusage first on PATH answers selection, so
# composition is exercised without the real stack or any reservation.
run_balanced() {
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK/home" \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" PI_CODING_AGENT_DIR="$WORK/pi" \
    bun "$ROOT/src/main.ts" "$@"
}

install_fake_balance() {
  mkdir -p "$WORK/bin"
  cat >"$WORK/bin/agentusage" <<'FAKE'
#!/usr/bin/env bash
if [ "$2" = "claude" ]; then
  printf '{"schema_version":1,"provider":"claude","ok":true,"route":{"id":"claude-swap:1","kind":"managed","slot":1},"reason":"selected"}\n'
else
  printf '{"schema_version":1,"provider":"codex","ok":true,"accountKey":"account:org-smoke","lease":null,"reason":"selected"}\n'
fi
FAKE
  chmod +x "$WORK/bin/agentusage"
}

expect_exit() {
  local expected="$1"
  shift
  local actual=0
  "$@" >"$WORK/out" 2>"$WORK/err" || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: expected exit $expected, got $actual: $*" >&2
    cat "$WORK/out" "$WORK/err" >&2
    exit 1
  fi
}

expect_out() {
  if ! grep -q -- "$1" "$WORK/out"; then
    echo "FAIL: output does not contain: $1" >&2
    cat "$WORK/out" >&2
    exit 1
  fi
}

# Help, version, doctor
expect_exit 0 run --version
expect_exit 0 run --agent-teaser
expect_exit 0 run --agent-help
expect_exit 0 run help open
expect_exit 0 run doctor
expect_exit 0 run doctor --json
expect_out '"harnesses"'

# Open, dry runs only
expect_exit 0 run open claude "hello there" --model fable --effort max --dry-run
expect_out "claude --model fable --effort max 'hello there'"
expect_exit 0 run open codex --effort xhigh --dry-run --json
expect_out 'model_reasoning_effort='
expect_exit 0 run open pi --effort high --dry-run
expect_out "pi --thinking high"
expect_exit 0 run open claude --dry-run --json -- --permission-mode plan
expect_out '"--permission-mode"'

# Usage faults exit 2 before anything runs
expect_exit 2 run open
expect_exit 2 run open cursor --dry-run
expect_exit 2 run open codex --effort max --dry-run
expect_exit 2 run open codex --name nope --dry-run
expect_exit 2 run open claude --json
expect_exit 2 run resume a/b --dry-run
expect_exit 2 run bogus-command

# Resume against a fixture store
SESSION_ID="05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60"
mkdir -p "$WORK/claude/projects/-somewhere"
printf '{}\n' >"$WORK/claude/projects/-somewhere/$SESSION_ID.jsonl"
expect_exit 0 run resume "$SESSION_ID" --dry-run
expect_out "claude --resume $SESSION_ID"
expect_exit 0 run resume "$SESSION_ID" --harness pi --dry-run
expect_out "pi --session $SESSION_ID"
expect_exit 1 run resume 99999999-9999-4999-9999-999999999999
expect_exit 1 run resume 99999999-9999-4999-9999-999999999999 --dry-run --json
expect_out '"code":"session_not_found"'

# Balanced launches compose the swap prefix (fake stack, dry runs only)
install_fake_balance
expect_exit 0 run_balanced open claude --model fable --dry-run
expect_out "cswap run 1 --share-history -- --model fable"
expect_exit 0 run_balanced open codex --dry-run
expect_out "codex-swap run --account account:org-smoke --"
expect_exit 0 run_balanced open pi --dry-run
expect_out "codex-swap pi run --account account:org-smoke --"
expect_exit 0 run_balanced resume "$SESSION_ID" --dry-run
expect_out "cswap run 1 --share-history -- --resume $SESSION_ID"
expect_exit 0 run_balanced open claude --x-no-balance --dry-run
expect_out "claude"
expect_exit 2 run_balanced open claude --x-account c1 --x-no-balance --dry-run

# Yolo mode from the personal config, dry runs only
mkdir -p "$WORK/home/.config/agentsurface"
printf '{"yolo":{"claude":true,"codex":true,"pi":true}}\n' >"$WORK/home/.config/agentsurface/config.json"
expect_exit 0 run open claude --dry-run
expect_out "claude --dangerously-skip-permissions"
expect_exit 0 run open codex --dry-run
expect_out "codex --dangerously-bypass-approvals-and-sandbox"
expect_exit 0 run open pi --dry-run
expect_out "pi --approve"
expect_exit 0 run resume "$SESSION_ID" --dry-run
expect_out "claude --resume $SESSION_ID --dangerously-skip-permissions"
expect_exit 0 run open claude --no-yolo --dry-run
if grep -q -- "--dangerously" "$WORK/out"; then
  echo "FAIL: --no-yolo still injected the flag" >&2
  exit 1
fi
expect_exit 0 run open codex --dry-run -- login
expect_out "codex login"
expect_exit 2 run open pi --yolo --no-yolo --dry-run

echo "smoke: all commands behaved"
