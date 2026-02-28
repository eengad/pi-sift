#!/usr/bin/env bash
set -euo pipefail

# Real runtime integration validation for pi-context-lens.
# Requires a working pi auth setup for the selected model.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${PI_VALIDATE_MODEL:-openai-codex/gpt-5.3-codex}"

cd "$ROOT_DIR"

npm run build >/dev/null

TMPDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

SESSION_DIR="$TMPDIR/sessions"
mkdir -p "$SESSION_DIR"
LARGE_FILE="$TMPDIR/large.txt"

# > 2000 chars so minCharsToScore triggers (default config)
python3 - "$LARGE_FILE" <<'PY'
import sys
path = sys.argv[1]
line = "this is a long line for context lens validation\n"
with open(path, "w") as f:
    for _ in range(5000):
        f.write(line)
PY

PROMPT="Use read tool on $LARGE_FILE then reply with done."

pi -p \
  --model "$MODEL" \
  --tools read \
  --session-dir "$SESSION_DIR" \
  -e "$ROOT_DIR/dist/index.js" \
  "$PROMPT" >/dev/null

SESSION_FILE="$(find "$SESSION_DIR" -name '*.jsonl' | head -1)"
if [[ -z "$SESSION_FILE" ]]; then
  echo "[FAIL] No session file generated"
  exit 1
fi

read -r CUSTOM_COUNT LENS_BLOCKS_LEFT < <(python3 - "$SESSION_FILE" <<'PY'
import json, sys
sf = sys.argv[1]
custom_count = 0
lens_blocks_left = 0
with open(sf) as f:
    for line in f:
        obj = json.loads(line)
        if obj.get('type') == 'custom' and obj.get('customType') == 'context_lens_decision':
            custom_count += 1
        if obj.get('type') == 'message' and obj.get('message', {}).get('role') == 'assistant':
            content = obj['message'].get('content', [])
            if isinstance(content, str):
                lens_blocks_left += int('<context_lens>' in content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'text':
                        lens_blocks_left += int('<context_lens>' in block.get('text', ''))
print(custom_count, lens_blocks_left)
PY
)

if [[ "$CUSTOM_COUNT" -lt 1 ]]; then
  echo "[FAIL] Expected >=1 context_lens_decision entry, got $CUSTOM_COUNT"
  exit 1
fi

if [[ "$LENS_BLOCKS_LEFT" -ne 0 ]]; then
  echo "[FAIL] Expected stripped <context_lens> blocks in assistant messages, found $LENS_BLOCKS_LEFT"
  exit 1
fi

echo "[PASS] Real Pi validation succeeded"
echo "       model=$MODEL decisions=$CUSTOM_COUNT stripped_blocks=$LENS_BLOCKS_LEFT"
