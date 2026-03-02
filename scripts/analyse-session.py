#!/usr/bin/env python3
"""Analyse a pi-sift benchmark session.

Usage:
  # Analyse extension session from a benchmark work directory:
  python3 scripts/analyse-session.py /tmp/tmp.XXX/task_0/extension_run1/sessions/*.jsonl

  # Or pass a session file directly:
  python3 scripts/analyse-session.py path/to/session.jsonl
"""
import json, re, sys


def load_entries(path):
    with open(path) as f:
        return [json.loads(line) for line in f]


def analyse(entries):
    # --- Decisions ---
    decisions = []
    for e in entries:
        if e.get("type") == "custom" and e.get("customType") == "context_lens_decision":
            d = e["data"]
            heuristic = "superseded" in str(d.get("summary", "")) or "stale" in str(
                d.get("summary", "")
            )
            decisions.append({**d, "heuristic": heuristic})

    print("=== DECISIONS ===")
    if not decisions:
        print("  (none)")
    for d in decisions:
        tag = " [HEURISTIC]" if d["heuristic"] else ""
        kl = f"  keepLines={d['keepLines']}" if d.get("keepLines") else ""
        print(
            f"  {d['action']:<10} id={d['toolCallId'][:30]}  "
            f"summary={d.get('summary', '')[:120]}{tag}"
        )
        if kl:
            print(f"  {' ' * 10} {kl}")

    # --- Build tool call index ---
    tool_calls = {}
    for e in entries:
        if e.get("type") != "message":
            continue
        m = e.get("message", {})
        content = m.get("content", [])
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "toolCall":
                tool_calls[b.get("id", "")] = b

    # --- Timeline ---
    print()
    print("=== TIMELINE ===")
    turn = 0
    for e in entries:
        if e.get("type") != "message":
            continue
        m = e.get("message", {})
        role = m.get("role")
        content = m.get("content", [])
        ts = e.get("timestamp", "")[11:19]

        if role == "assistant":
            turn += 1
            tools = []
            model_decisions = []
            if isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "toolCall":
                        args = b.get("arguments", {})
                        path = (
                            args.get("path")
                            or args.get("filePath")
                            or args.get("command", "")[:60]
                        )
                        offset = args.get("offset")
                        limit = args.get("limit")
                        if offset and limit:
                            extra = f" lines {offset}-{int(offset) + int(limit)}"
                        elif offset:
                            extra = f" @{offset}"
                        else:
                            extra = ""
                        tools.append(f"{b.get('name', '')}: {path}{extra}")
                    if b.get("type") == "text":
                        for match in re.finditer(
                            r"<context_lens>(.*?)</context_lens>",
                            b.get("text", ""),
                            re.DOTALL,
                        ):
                            d = json.loads(match.group(1))
                            model_decisions.append(
                                f"{d['action']} {d['toolCallId'][:20]}"
                            )
            print(f"T{turn} [{ts}]")
            for d in model_decisions:
                print(f"  DECISION: {d}")
            for t in tools:
                print(f"  CALL: {t}")

        elif role == "toolResult":
            tid = m.get("toolCallId", "")[:20]
            sz = 0
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        sz = len(b.get("text", ""))
                        break
            marker = " [SCORED]" if sz >= 5000 else ""
            print(f"  result: {sz}ch{marker}  ({tid})")

    # --- Usage summary ---
    print()
    print("=== USAGE ===")
    usage_in = usage_out = usage_total = 0
    cost_total = 0.0
    assistant_msgs = tool_results = custom_decisions = 0

    for e in entries:
        if e.get("type") == "custom" and e.get("customType") == "context_lens_decision":
            custom_decisions += 1
        if e.get("type") != "message":
            continue
        m = e.get("message", {})
        role = m.get("role")
        if role == "assistant":
            assistant_msgs += 1
            u = m.get("usage") or {}
            usage_in += int(u.get("input", 0) or 0)
            usage_out += int(u.get("output", 0) or 0)
            usage_total += int(u.get("totalTokens", 0) or 0)
            c = (u.get("cost") or {}).get("total", 0) or 0
            try:
                cost_total += float(c)
            except Exception:
                pass
        elif role == "toolResult":
            tool_results += 1

    print(f"  Assistant turns: {assistant_msgs}")
    print(f"  Tool results:    {tool_results}")
    print(f"  Total tokens:    {usage_total:,}")
    print(f"  Cost (USD):      ${cost_total:.4f}")
    print(f"  Decisions:       {custom_decisions}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for path in sys.argv[1:]:
        if len(sys.argv) > 2:
            print(f"\n{'=' * 60}")
            print(f"FILE: {path}")
            print(f"{'=' * 60}")
        entries = load_entries(path)
        analyse(entries)
