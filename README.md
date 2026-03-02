# pi-sift

A [Pi Coding Agent](https://github.com/nicepkg/pi-coding-agent) extension that prevents large and unnecessary tool results from polluting the context. The model scores large results for relevance and replaces low-value content with concise summaries, optionally preserving critical line ranges verbatim (`keepLines`).

## How it works

1. When a tool result exceeds a size threshold, pi-sift appends a scoring prompt asking the model to decide: **keep**, **summarize**, or **dismiss**.
2. On summarize, the model can specify `keepLines` — line ranges to preserve verbatim while compressing the rest.
3. Before each API call, the context hook replaces scored content with the summary + kept lines.
4. Heuristic dismiss auto-removes stale reads when files are re-read or edited, but preserves summarize+keepLines decisions.

## Install

```bash
pi install pi-sift
```

Or from source:

```bash
pi install https://github.com/eengad/pi-sift
```

## Benchmark results (SWE-ReBench, claude-opus-4-6, N=1 per task)

| Task | Baseline tokens | Extension tokens | Δ tokens | Δ cost | Δ latency |
|---|---|---|---|---|---|
| pennylane-7671 | 91k | 69k | **-25%** | **-20%** | **-58%** |
| haystack-9527 | 821k | 135k | **-83%** | **-41%** | **-72%** |
| stellarphot-519 | 2,593k | 2,619k | +1% | +20% | +6% |
| stellarphot-526 | 67k | 53k | **-20%** | +11% | **-12%** |

Resolution unchanged (1/4 for both). Single runs — variance is possible, especially on task 3 (98 turns). Full results in [`benchmark-keeplines-results.md`](./benchmark-keeplines-results.md).

## Local development

```bash
npm install
npm run build
npm test
```

## A/B benchmark

Run baseline vs extension on SWE-ReBench tasks with Docker verification:

```bash
npm run benchmark:swe-pipeline-ab
```

Override defaults with env vars:

```bash
PI_BENCH_TASKS=0,1,2 \
PI_BENCH_CONFIGS=extension \
PI_BENCH_KEEP_WORKDIR=1 \
npm run benchmark:swe-pipeline-ab
```

Analyse session logs after a run:

```bash
npm run analyse-session -- /tmp/tmp.XXX/task_0/extension_run1/sessions/*.jsonl
```

## Links

- Design: [`DESIGN.md`](./DESIGN.md)
- Improvement ideas: [`IMPROVEMENTS.md`](./IMPROVEMENTS.md)
