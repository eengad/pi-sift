#!/usr/bin/env bash
set -euo pipefail

# A/B benchmark that uses SWE_ReBench's verification pipeline (patch correctness)
# while comparing pi baseline vs pi-context-lens extension for latency/tokens/cost.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${PI_BENCH_MODEL:-openai-codex/gpt-5.3-codex}"
DATASET="${PI_BENCH_DATASET:-nebius/SWE-rebench}"
SPLIT="${PI_BENCH_SPLIT:-test}"
TASK_INDICES="${PI_BENCH_TASKS:-1,2}"
RUNS_PER_TASK="${PI_BENCH_RUNS:-1}"
MAX_PROBLEM_CHARS="${PI_BENCH_MAX_PROBLEM_CHARS:-6000}"
RUN_TIMEOUT_SEC="${PI_BENCH_TIMEOUT_SEC:-900}"
VERIFY_TIMEOUT_SEC="${PI_BENCH_VERIFY_TIMEOUT_SEC:-900}"
WORK_ROOT="${PI_BENCH_WORK_ROOT:-$(mktemp -d)}"
KEEP_WORKDIR="${PI_BENCH_KEEP_WORKDIR:-0}"
CONFIGS="${PI_BENCH_CONFIGS:-baseline,extension}"

SWE_REBENCH_URL="${PI_BENCH_SWE_REBENCH_URL:-https://github.com/DivyeshJayswal/SWE_ReBench.git}"
SWE_REBENCH_DIR="${PI_BENCH_SWE_REBENCH_DIR:-$WORK_ROOT/SWE_ReBench}"

RESULTS_FILE="$WORK_ROOT/results.jsonl"
TASKS_JSON="$WORK_ROOT/all_tasks.json"

cleanup() {
  if [[ "$KEEP_WORKDIR" != "1" ]]; then
    rm -rf "$WORK_ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$WORK_ROOT"

cd "$ROOT_DIR"
npm run build >/dev/null

if [[ ! -d "$SWE_REBENCH_DIR/.git" ]]; then
  git clone --depth 1 "$SWE_REBENCH_URL" "$SWE_REBENCH_DIR" >/dev/null 2>&1
  # Patch upstream bugs in execution_env.py:
  # 1. Docker requires lowercase image tags
  # 2. _parse_tests regex only matches verbose format, not -rA summary format
  python3 - "$SWE_REBENCH_DIR/execution_env.py" <<'PATCH'
import sys
path = sys.argv[1]
code = open(path).read()
code = code.replace(
    'return f"swe-rebench/{repo}',
    'return f"swe-rebench/{repo.lower()}'
)
code = code.replace(
    """    def _parse_tests(self, output: str) -> Tuple[List[str], List[str]]:
        passed, failed = [], []
        for m in re.finditer(r'(\S+::\S+)\s+PASSED', output):
            passed.append(m.group(1))
        for m in re.finditer(r'(\S+::\S+)\s+FAILED', output):
            failed.append(m.group(1))
        return passed, failed""",
    """    def _parse_tests(self, output: str) -> Tuple[List[str], List[str]]:
        passed, failed = set(), set()
        for line in output.splitlines():
            # verbose: "test::name PASSED"
            m = re.search(r'(\S+::\S+)\s+PASSED', line)
            if m:
                passed.add(m.group(1))
                continue
            # -rA summary: "PASSED test::name"
            m = re.search(r'PASSED\s+(\S+::\S+)', line)
            if m:
                passed.add(m.group(1))
                continue
            m = re.search(r'(\S+::\S+)\s+FAILED', line)
            if m:
                failed.add(m.group(1))
                continue
            m = re.search(r'FAILED\s+(\S+::\S+)', line)
            if m:
                failed.add(m.group(1))
        return list(passed), list(failed)"""
)
open(path, 'w').write(code)
PATCH
fi

# Pull task rows from HF dataset-server preview endpoint (first-rows).
python3 - "$TASKS_JSON" "$DATASET" "$SPLIT" "$MAX_PROBLEM_CHARS" <<'PY'
import json, sys, urllib.parse, urllib.request
out_path, dataset, split, max_chars = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
url = (
    "https://datasets-server.huggingface.co/first-rows?"
    + urllib.parse.urlencode({"dataset": dataset, "config": "default", "split": split})
)
with urllib.request.urlopen(url) as r:
    payload = json.load(r)
rows = payload.get("rows", [])
if not rows:
    raise SystemExit("No rows returned from dataset-server first-rows endpoint")

# Keep full row for verification, but trim problem statement for prompting.
tasks = []
for entry in rows:
    row = entry["row"]
    repo = row["repo"].removeprefix("https://github.com/").removesuffix(".git")
    prompt_problem = (row.get("problem_statement", "") or "")[:max_chars]
    tasks.append({
        "instance_id": row["instance_id"],
        "repo": repo,
        "base_commit": row["base_commit"],
        "problem_statement": prompt_problem,
        "raw_row": row,
    })

with open(out_path, "w") as f:
    json.dump(tasks, f)
PY

IFS=',' read -ra INDICES <<< "$TASK_INDICES"
> "$RESULTS_FILE"

for task_idx in "${INDICES[@]}"; do
  task_idx=$(echo "$task_idx" | tr -d ' ')
  TASK_DIR="$WORK_ROOT/task_${task_idx}"
  mkdir -p "$TASK_DIR"

  read -r INSTANCE_ID REPO BASE_COMMIT < <(python3 - "$TASKS_JSON" "$task_idx" <<'PY'
import json,sys
tasks=json.load(open(sys.argv[1]))
idx=int(sys.argv[2])
if idx < 0 or idx >= len(tasks):
    raise SystemExit(f"Task index out of range: {idx} (available 0..{len(tasks)-1})")
t=tasks[idx]
print(t['instance_id'], t['repo'], t['base_commit'])
PY
)

  echo "=== Task $task_idx: $INSTANCE_ID (repo=$REPO) ==="

  REPO_DIR="$TASK_DIR/repo"
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    git clone "https://github.com/${REPO}.git" "$REPO_DIR" >/dev/null 2>&1
  fi

  PROMPT_FILE="$TASK_DIR/prompt.txt"
  python3 - "$TASKS_JSON" "$task_idx" "$PROMPT_FILE" <<'PY'
import json,sys
tasks=json.load(open(sys.argv[1]))
idx=int(sys.argv[2])
out=sys.argv[3]
t=tasks[idx]
prompt=f"""Solve this real SWE-rebench task in this checked-out repository.

Task instance: {t['instance_id']}
Repo: {t['repo']}
Base commit: {t['base_commit']}

Problem statement:
{t['problem_statement']}

Requirements:
1) Make minimal, targeted code edits to fix the issue.
2) Do not do broad refactors or unrelated cleanup.
3) When done, provide a brief summary of changed files and why.
4) End with the single word: done
"""
open(out, "w").write(prompt)
PY

  for run_num in $(seq 1 "$RUNS_PER_TASK"); do
    IFS=',' read -ra CFG_LIST <<< "$CONFIGS"
    for config in "${CFG_LIST[@]}"; do
      RUN_DIR="$TASK_DIR/${config}_run${run_num}"
      SESSION_DIR="$RUN_DIR/sessions"
      OUTPUT_FILE="$RUN_DIR/output.txt"
      PATCH_FILE="$RUN_DIR/patch.diff"
      VERIFY_FILE="$RUN_DIR/verify.json"
      mkdir -p "$SESSION_DIR"

      echo "  [$config] run $run_num/$RUNS_PER_TASK ..."

      cd "$REPO_DIR"
      git reset --hard "$BASE_COMMIT" >/dev/null 2>&1 || true
      git clean -fd >/dev/null 2>&1 || true
      git checkout "$BASE_COMMIT" >/dev/null 2>&1 || true

      start_ts=$(date +%s)
      run_rc=0
      if [[ "$config" == "extension" ]]; then
        timeout "${RUN_TIMEOUT_SEC}s" pi -p \
          --model "$MODEL" \
          --tools read,grep,find,ls,edit,write,bash \
          --session-dir "$SESSION_DIR" \
          -e "$ROOT_DIR/dist/index.js" \
          "@${PROMPT_FILE}" >"$OUTPUT_FILE" 2>/dev/null || run_rc=$?
      else
        timeout "${RUN_TIMEOUT_SEC}s" pi -p \
          --model "$MODEL" \
          --tools read,grep,find,ls,edit,write,bash \
          --session-dir "$SESSION_DIR" \
          "@${PROMPT_FILE}" >"$OUTPUT_FILE" 2>/dev/null || run_rc=$?
      fi
      end_ts=$(date +%s)
      elapsed=$((end_ts - start_ts))

      if [[ "$run_rc" -eq 124 ]]; then
        echo "    ! timeout after ${RUN_TIMEOUT_SEC}s ($config run $run_num)"
      fi

      git add -A >/dev/null 2>&1 || true
      git diff --cached >"$PATCH_FILE" || true

      # Verify patch with SWE_ReBench pipeline (TaskInstance + DockerEnvironment.verify_solution)
      python3 - "$SWE_REBENCH_DIR" "$TASKS_JSON" "$task_idx" "$PATCH_FILE" "$VERIFY_TIMEOUT_SEC" >"$VERIFY_FILE" <<'PY'
import json, sys, time, traceback

swe_dir, tasks_json, idx, patch_file, verify_timeout = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
sys.path.insert(0, swe_dir)

result = {
    "verify_ok": False,
    "resolved": False,
    "verify_time_sec": 0,
    "verify_error": "",
    "passed_tests": 0,
    "failed_tests": 0,
}

start = time.time()
try:
    from dataset_loader import DatasetLoader
    from execution_env import DockerEnvironment

    tasks = json.load(open(tasks_json))
    row = tasks[idx]["raw_row"]
    loader = DatasetLoader()
    task = loader._parse_task_item(row)
    if task is None:
        raise RuntimeError("Failed to parse task row into TaskInstance")

    patch = open(patch_file).read()
    if not patch.strip():
        result.update({
            "verify_ok": True,
            "resolved": False,
            "verify_error": "No patch generated"
        })
    else:
        env = DockerEnvironment(timeout=verify_timeout)
        resolved, execution_result = env.verify_solution(task, patch)
        result.update({
            "verify_ok": True,
            "resolved": bool(resolved),
            "verify_error": execution_result.error_message or "",
            "passed_tests": len(execution_result.passed_tests or []),
            "failed_tests": len(execution_result.failed_tests or []),
        })
except Exception as e:
    result.update({
        "verify_ok": False,
        "resolved": False,
        "verify_error": f"{type(e).__name__}: {e}",
    })

result["verify_time_sec"] = round(time.time() - start, 3)
print(json.dumps(result))
PY

      session_file="$(find "$SESSION_DIR" -name '*.jsonl' | head -1 || echo '')"

      python3 - "$session_file" "$OUTPUT_FILE" "$VERIFY_FILE" "$PATCH_FILE" "$elapsed" "$config" "$INSTANCE_ID" "$run_num" "$task_idx" "$run_rc" >>"$RESULTS_FILE" <<'PY'
import json, sys
session_file, output_file, verify_file, patch_file = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
elapsed, config, instance_id = int(sys.argv[5]), sys.argv[6], sys.argv[7]
run_num, task_idx, run_rc = int(sys.argv[8]), int(sys.argv[9]), int(sys.argv[10])

usage_in = usage_out = usage_total = 0
cost_total = 0.0
assistant_msgs = tool_results = custom_decisions = lens_blocks = 0

if session_file:
    with open(session_file) as f:
        for line in f:
            o = json.loads(line)
            if o.get('type') == 'custom' and o.get('customType') == 'context_lens_decision':
                custom_decisions += 1
            if o.get('type') == 'message':
                m = o.get('message', {})
                role = m.get('role')
                if role == 'assistant':
                    assistant_msgs += 1
                    u = m.get('usage') or {}
                    usage_in += int(u.get('input', 0) or 0)
                    usage_out += int(u.get('output', 0) or 0)
                    usage_total += int(u.get('totalTokens', 0) or 0)
                    c = (u.get('cost') or {}).get('total', 0) or 0
                    try:
                        cost_total += float(c)
                    except Exception:
                        pass
                    content = m.get('content', [])
                    if isinstance(content, str):
                        lens_blocks += int('<context_lens>' in content)
                    elif isinstance(content, list):
                        for b in content:
                            if isinstance(b, dict) and b.get('type') == 'text':
                                lens_blocks += int('<context_lens>' in b.get('text', ''))
                elif role == 'toolResult':
                    tool_results += 1

final = open(output_file).read().strip() if output_file else ""
verify = json.load(open(verify_file))
patch_chars = len(open(patch_file).read()) if patch_file else 0

obj = {
    'task_index': task_idx,
    'instance_id': instance_id,
    'config': config,
    'run': run_num,
    'run_rc': run_rc,
    'elapsed_sec': elapsed,
    'assistant_messages': assistant_msgs,
    'tool_results': tool_results,
    'input_tokens': usage_in,
    'output_tokens': usage_out,
    'total_tokens': usage_total,
    'cost_usd': round(cost_total, 6),
    'custom_decisions': custom_decisions,
    'lens_blocks_left': lens_blocks,
    'ended_with_done': final.endswith('done'),
    'patch_chars': patch_chars,
    'verify_ok': bool(verify.get('verify_ok')),
    'resolved': bool(verify.get('resolved')),
    'verify_time_sec': verify.get('verify_time_sec', 0),
    'verify_error': verify.get('verify_error', ''),
    'passed_tests': int(verify.get('passed_tests', 0) or 0),
    'failed_tests': int(verify.get('failed_tests', 0) or 0),
}
print(json.dumps(obj))
PY
    done
  done
done

echo ""
echo "=== AGGREGATE RESULTS (SWE Pipeline) ==="

python3 - "$RESULTS_FILE" <<'PY'
import json, sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1])]
if not rows:
    print("No results collected")
    raise SystemExit(0)

def avg(xs):
    return sum(xs)/len(xs) if xs else 0

def pct(a,b):
    return ((b-a)/a*100) if a else None

by_task = defaultdict(lambda: {"baseline": [], "extension": []})
for r in rows:
    by_task[r['instance_id']][r['config']].append(r)

print(f"{'Task':<45} {'N':>3} | {'Resolved B/E':>12} | {'Base lat':>8} {'Ext lat':>8} {'Δ%':>8} | {'Base tok':>10} {'Ext tok':>10} {'Δ%':>8} | {'Base $':>8} {'Ext $':>8} {'Δ%':>8} | {'Decisions':>9}")
print('-'*170)

all_b=[]; all_e=[]
for task, cfg in sorted(by_task.items()):
    b=cfg['baseline']; e=cfg['extension']
    n=min(len(b),len(e))

    be=avg([x['elapsed_sec'] for x in b]); ee=avg([x['elapsed_sec'] for x in e])
    bt=avg([x['total_tokens'] for x in b]); et=avg([x['total_tokens'] for x in e])
    bc=avg([x['cost_usd'] for x in b]); ec=avg([x['cost_usd'] for x in e])
    br=sum(1 for x in b if x['resolved']); er=sum(1 for x in e if x['resolved'])
    dec=sum(x['custom_decisions'] for x in e)

    all_b.extend(b); all_e.extend(e)

    p_lat=pct(be,ee); p_tok=pct(bt,et); p_cost=pct(bc,ec)
    print(f"{task:<45} {n:>3} | {br}/{len(b)} -> {er}/{len(e):<3} | {be:>7.0f}s {ee:>7.0f}s {('n/a' if p_lat is None else f'{p_lat:+.1f}%'):>8} | {bt:>10.0f} {et:>10.0f} {('n/a' if p_tok is None else f'{p_tok:+.1f}%'):>8} | ${bc:>7.4f} ${ec:>7.4f} {('n/a' if p_cost is None else f'{p_cost:+.1f}%'):>8} | {dec:>9}")

print('-'*170)
tbe=avg([x['elapsed_sec'] for x in all_b]); tee=avg([x['elapsed_sec'] for x in all_e])
tbt=avg([x['total_tokens'] for x in all_b]); tet=avg([x['total_tokens'] for x in all_e])
tbc=avg([x['cost_usd'] for x in all_b]); tec=avg([x['cost_usd'] for x in all_e])
tbr=sum(1 for x in all_b if x['resolved']); ter=sum(1 for x in all_e if x['resolved'])
tdec=sum(x['custom_decisions'] for x in all_e)

tp_lat=pct(tbe,tee); tp_tok=pct(tbt,tet); tp_cost=pct(tbc,tec)
print(f"{'OVERALL AVERAGE':<45} {'':>3} | {tbr}/{len(all_b)} -> {ter}/{len(all_e):<3} | {tbe:>7.0f}s {tee:>7.0f}s {('n/a' if tp_lat is None else f'{tp_lat:+.1f}%'):>8} | {tbt:>10.0f} {tet:>10.0f} {('n/a' if tp_tok is None else f'{tp_tok:+.1f}%'):>8} | ${tbc:>7.4f} ${tec:>7.4f} {('n/a' if tp_cost is None else f'{tp_cost:+.1f}%'):>8} | {tdec:>9}")
print(f"\nTotal runs: {len(rows)} ({len(all_b)} baseline + {len(all_e)} extension)")
print(f"Results: {sys.argv[1]}")
PY
