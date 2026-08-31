#!/usr/bin/env bash
set -euo pipefail

# End-to-end CLI and installer checks against disposable roots. No real
# harness launches, native stores, account state, or installed commands.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RESOURCES="$WORK/home/.local/share/agentstart/resources"
mkdir -p "$RESOURCES/skills/collab" "$RESOURCES/claude/agent/.claude-plugin"
printf '# collab\n' >"$RESOURCES/skills/collab/SKILL.md"
printf 'collab\n' >"$RESOURCES/managed-skills.txt"
printf '{}\n' >"$RESOURCES/claude/agent/.claude-plugin/plugin.json"

run() {
  env -i PATH="$PATH" HOME="$WORK/home" AGENTLAUNCH_NO_BALANCE=1 \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" \
    bun "$ROOT/src/main.ts" "$@"
}

run_balanced() {
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK/home" \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" \
    bun "$ROOT/src/main.ts" "$@"
}

expect_exit() {
  local expected="$1"
  shift
  local actual=0
  "$@" >"$WORK/out" 2>"$WORK/err" || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: expected exit $expected, got $actual: $*" >&2
    sed -n '1,120p' "$WORK/out" "$WORK/err" >&2
    exit 1
  fi
}

expect_out() {
  grep -q -- "$1" "$WORK/out" || {
    echo "FAIL: stdout does not contain: $1" >&2
    sed -n '1,120p' "$WORK/out" >&2
    exit 1
  }
}

expect_err() {
  grep -q -- "$1" "$WORK/err" || {
    echo "FAIL: stderr does not contain: $1" >&2
    sed -n '1,120p' "$WORK/err" >&2
    exit 1
  }
}

# Help, version, and read-only diagnosis.
expect_exit 0 run --version
expect_out "agentlaunch 0.1.0"
expect_exit 0 run --agent-teaser
expect_exit 0 run --agent-help
expect_exit 0 run --x-help
expect_exit 0 run x-doctor --x-json
expect_out '"harnesses"'
expect_out '"catalog"'
if [[ -e "$WORK/home/.config/agentlaunch" || -e "$WORK/home/.local/state/agentlaunch" ]]; then
  echo "FAIL: x-doctor wrote AgentLaunch state" >&2
  exit 1
fi

# Catalog resolution and native spellings.
expect_exit 0 run --x-harness claude --x-dry-run
expect_out "--dangerously-skip-permissions --allow-dangerously-skip-permissions --model 'opus\[1m\]' --effort medium"
expect_exit 0 run --x-harness codex --x-no-yolo --x-dry-run
expect_out "--cd .* --model gpt-5.6-sol -c 'model_reasoning_effort=\"high\"'"
expect_exit 0 run --x-harness codex --x-level gpt-5.6-luna:max --x-no-yolo --x-dry-run
expect_out "--model gpt-5.6-luna -c 'model_reasoning_effort=\"max\"'"
expect_exit 0 run --x-level sonnet:high --x-no-yolo --x-dry-run
expect_out "--model sonnet --effort high"

# Native naming is opaque input: forwarded once and absent from launcher data.
expect_exit 0 run --x-harness claude --x-no-yolo --x-dry-run --x-json --name "native title"
expect_out '"--name","native title"'
if grep -q '"name"' "$WORK/out"; then
  echo "FAIL: AgentLaunch interpreted native --name as metadata" >&2
  exit 1
fi
expect_exit 0 run --x-harness codex --x-no-yolo --x-dry-run -n native
expect_out "--model gpt-5.6-sol -c 'model_reasoning_effort=\"high\"' -n native"
expect_exit 2 run --x-harness claude --x-name launcher-name --x-dry-run
expect_err 'unknown option "--x-name"'

# Levels own both dimensions; ordinary launches yield to native dimensions.
expect_exit 0 run --x-harness claude --model sonnet --x-no-yolo --x-dry-run
expect_out "--effort medium --model sonnet"
expect_exit 2 run --x-harness claude --x-level opus:high --model sonnet --x-dry-run
expect_exit 2 run --x-level opus --x-dry-run
expect_exit 2 run --x-harness cursor --x-dry-run
expect_exit 2 run --x-dry-run

# Retired harness spellings fail before they can become a prompt or broaden
# a scoped policy to every remaining harness.
expect_exit 2 run --x-harness pi --x-dry-run
expect_err 'harness "pi" is retired'
expect_exit 2 run --x-harness pi:gpt-5.6-luna:max --x-dry-run
expect_err 'harness "pi" is retired'
for flag in --x-yolo --x-no-yolo; do
  expect_exit 2 run --x-harness codex "$flag" pi --x-dry-run
  expect_err 'scope "pi" names a retired harness'
  expect_exit 2 run --x-harness codex "$flag=pi" --x-dry-run
  expect_err 'scope "pi" names a retired harness'
done

# Yolo policy, native gate ownership, and utility passthrough.
expect_exit 0 run --x-harness claude --dangerously-skip-permissions --x-no-yolo --x-dry-run
if grep -q -- "--dangerously" "$WORK/out"; then
  echo "FAIL: --x-no-yolo did not redact the forwarded positive spelling" >&2
  exit 1
fi
expect_err "removed --dangerously-skip-permissions"
expect_exit 0 run --x-harness claude --permission-mode plan --x-dry-run
expect_out "--permission-mode plan"
expect_err "the caller's spelling wins"
mkdir -p "$WORK/home/.config/agentlaunch"
printf '{"yolo":false}\n' >"$WORK/home/.config/agentlaunch/config.json"
expect_exit 0 run --x-harness claude --x-dry-run
if grep -q -- "--dangerously" "$WORK/out"; then
  echo "FAIL: disabling config still injected yolo" >&2
  exit 1
fi
expect_exit 0 run --x-harness codex --x-dry-run login
expect_out "codex login"
rm "$WORK/home/.config/agentlaunch/config.json"

# Usage faults happen before launch and unknown x commands stay reserved.
expect_exit 2 run --x-bogus
expect_exit 2 run x-something
expect_exit 2 run --x-harness claude --x-json
expect_exit 2 run x-resume a/b --x-dry-run
expect_exit 2 run x-runs
expect_exit 2 run x-land anything

# Native-store resume and cwd recovery.
SESSION_ID="05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60"
SESSION_CWD="$WORK/session-cwd"
mkdir -p "$WORK/claude/projects/-somewhere" "$SESSION_CWD"
printf '{"cwd":"%s"}\n' "$SESSION_CWD" >"$WORK/claude/projects/-somewhere/$SESSION_ID.jsonl"
expect_exit 0 run x-resume "$SESSION_ID" --x-no-yolo --x-dry-run --x-json
expect_out '"--resume"'
expect_out "\"cwd\":\"$SESSION_CWD\""
expect_exit 2 run x-resume "$SESSION_ID" --x-level opus:high --x-dry-run
expect_exit 1 run x-resume 99999999-9999-4999-9999-999999999999 --x-dry-run --x-json
expect_out '"code":"session_not_found"'
expect_exit 2 run x-resume run:not-a-native-id --x-dry-run

# Balanced prefix composition with a fake read-only selector.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/agentusage" <<'FAKE'
#!/usr/bin/env bash
if [ "$2" = "claude" ]; then
  printf '{"schema_version":1,"provider":"claude","ok":true,"route":{"id":"claude-swap:1","slot":1},"reason":"selected"}\n'
else
  printf '{"schema_version":1,"provider":"codex","ok":true,"accountKey":"account:smoke","lease":null,"reason":"selected"}\n'
fi
FAKE
chmod +x "$WORK/bin/agentusage"
expect_exit 0 run_balanced --x-harness claude --x-no-yolo --x-dry-run
expect_out "cswap run 1 --share-history --"
expect_exit 0 run_balanced --x-harness codex --x-no-yolo --x-dry-run
expect_out "codex-swap run --account account:smoke --"

# Narration never contaminates stdout; JSON silences it.
expect_exit 0 run --x-harness claude --x-no-yolo --x-dry-run
[[ "$(cat "$WORK/out")" == "claude --plugin-dir $RESOURCES/claude/agent --model 'opus[1m]' --effort medium" ]] || {
  echo "FAIL: narrative leaked into stdout" >&2
  exit 1
}
expect_err '^open      claude$'
expect_exit 0 run --x-harness claude --x-dry-run --x-json --x-verbose
[[ ! -s "$WORK/err" ]] || { echo "FAIL: JSON did not silence narration" >&2; exit 1; }

# Hermetic installer convergence and verified uninstall. The legacy harness
# name below is ownership evidence for the exact retired receipt schema; it is
# not an accepted launch, catalog, or config value.
INSTALL_BIN="$WORK/install/bin"
INSTALL_STATE="$WORK/install/state"
mkdir -p "$INSTALL_STATE/capabilities/pi"
chmod 700 "$INSTALL_STATE" "$INSTALL_STATE/capabilities" "$INSTALL_STATE/capabilities/pi"
cat >"$INSTALL_STATE/capabilities/pi/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json" <<'EOF'
{
  "schema_version": 1,
  "harness": "pi",
  "session_id": "c9889494-8da8-4b34-9a14-c0e3c7f8b9b0",
  "capabilities": ["common", "focus"],
  "digest": "ae8f157f1a72a6114001d56b"
}
EOF
chmod 600 "$INSTALL_STATE/capabilities/pi/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json"
AGENTLAUNCH_INSTALL_BIN_DIR="$INSTALL_BIN" \
  AGENTLAUNCH_INSTALL_STATE_DIR="$INSTALL_STATE" \
  "$ROOT/scripts/install.sh" --install >"$WORK/install-out"
[[ -L "$INSTALL_BIN/agentlaunch" ]]
[[ "$(readlink "$INSTALL_BIN/agentlaunch")" == "$ROOT/src/main.ts" ]]
[[ "$(stat -f %Lp "$INSTALL_STATE/deployed-sha" 2>/dev/null || stat -c %a "$INSTALL_STATE/deployed-sha")" == "600" ]]
[[ ! -e "$INSTALL_STATE/capabilities" && ! -L "$INSTALL_STATE/capabilities" ]]
grep -F 'Removed retired AgentLaunch capability receipts:' "$WORK/install-out" >/dev/null
AGENTLAUNCH_INSTALL_BIN_DIR="$INSTALL_BIN" \
  AGENTLAUNCH_INSTALL_STATE_DIR="$INSTALL_STATE" \
  "$ROOT/scripts/install.sh" --install >>"$WORK/install-out"
AGENTLAUNCH_INSTALL_BIN_DIR="$INSTALL_BIN" \
  AGENTLAUNCH_INSTALL_STATE_DIR="$INSTALL_STATE" \
  "$ROOT/scripts/install.sh" --uninstall >>"$WORK/install-out"
[[ ! -e "$INSTALL_BIN/agentlaunch" && ! -L "$INSTALL_BIN/agentlaunch" ]]

# A lookalike is preserved and blocks installation: cleanup must prove the
# complete retired schema before removing anything.
REFUSE_BIN="$WORK/refuse/bin"
REFUSE_STATE="$WORK/refuse/state"
mkdir -p "$REFUSE_STATE/capabilities/pi"
chmod 700 "$REFUSE_STATE" "$REFUSE_STATE/capabilities" "$REFUSE_STATE/capabilities/pi"
printf '{}\n' >"$REFUSE_STATE/capabilities/pi/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json"
chmod 600 "$REFUSE_STATE/capabilities/pi/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json"
if AGENTLAUNCH_INSTALL_BIN_DIR="$REFUSE_BIN" \
  AGENTLAUNCH_INSTALL_STATE_DIR="$REFUSE_STATE" \
  "$ROOT/scripts/install.sh" --install >"$WORK/refuse-out" 2>"$WORK/refuse-err"; then
  echo "FAIL: installer accepted an unrecognized retired capability receipt" >&2
  exit 1
fi
grep -F 'Refusing unrecognized retired capability receipts:' "$WORK/refuse-err" >/dev/null
[[ -f "$REFUSE_STATE/capabilities/pi/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json" ]]
[[ ! -e "$REFUSE_BIN/agentlaunch" && ! -L "$REFUSE_BIN/agentlaunch" ]]

# A shape-valid receipt under a foreign harness name is still not provenance:
# the retired vocabulary is exact, not a lowercase-name pattern.
FOREIGN_BIN="$WORK/foreign/bin"
FOREIGN_STATE="$WORK/foreign/state"
mkdir -p "$FOREIGN_STATE/capabilities/legacy"
chmod 700 "$FOREIGN_STATE" "$FOREIGN_STATE/capabilities" "$FOREIGN_STATE/capabilities/legacy"
cat >"$FOREIGN_STATE/capabilities/legacy/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json" <<'EOF'
{
  "schema_version": 1,
  "harness": "legacy",
  "session_id": "c9889494-8da8-4b34-9a14-c0e3c7f8b9b0",
  "capabilities": ["common", "focus"],
  "digest": "ae8f157f1a72a6114001d56b"
}
EOF
chmod 600 "$FOREIGN_STATE/capabilities/legacy/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json"
if AGENTLAUNCH_INSTALL_BIN_DIR="$FOREIGN_BIN" \
  AGENTLAUNCH_INSTALL_STATE_DIR="$FOREIGN_STATE" \
  "$ROOT/scripts/install.sh" --install >"$WORK/foreign-out" 2>"$WORK/foreign-err"; then
  echo "FAIL: installer accepted a foreign retired harness directory" >&2
  exit 1
fi
grep -F 'unknown harness directory legacy' "$WORK/foreign-err" >/dev/null
[[ -f "$FOREIGN_STATE/capabilities/legacy/c9889494-8da8-4b34-9a14-c0e3c7f8b9b0.json" ]]
[[ ! -e "$FOREIGN_BIN/agentlaunch" && ! -L "$FOREIGN_BIN/agentlaunch" ]]

echo "smoke: launch, resume, doctor, balance, and installer behaved"
