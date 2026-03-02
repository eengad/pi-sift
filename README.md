# pi-sift

A Pi Coding Agent extension that reduces context bloat by having the model score large tool results for relevance and replacing low-value content with concise summaries.

Current status: **initial implementation (Mode A / piggyback) scaffold**.

## Install

```bash
pi install https://github.com/eengad/pi-sift
```

- Design: [`DESIGN.md`](./DESIGN.md)
- Improvement ideas: [`IMPROVEMENTS.md`](./IMPROVEMENTS.md)
- Source: [`src/index.ts`](./src/index.ts)

## Local development

```bash
npm install
npm run check
npm run build
```

## Validation

Run end-to-end phase-1 validation (typecheck + unit + flow tests):

```bash
npm run validate
```

Run a **real Pi runtime** integration validation (requires authenticated `pi` model access):

```bash
npm run validate:real
```

Optional model override:

```bash
PI_VALIDATE_MODEL=openai-codex/gpt-5.3-codex npm run validate:real
```

## A/B benchmark with SWE-ReBench verification pipeline (patch correctness)

Run baseline vs extension and evaluate each generated patch with SWE_ReBench's Docker verification flow (`DockerEnvironment.verify_solution`):

```bash
npm run benchmark:swe-pipeline-ab
```

Defaults: model `anthropic/claude-opus-4-6`, dataset `nebius/SWE-rebench-leaderboard`, task 0. Override with env vars:

```bash
PI_BENCH_MODEL=anthropic/claude-opus-4-6 \
PI_BENCH_DATASET=nebius/SWE-rebench-leaderboard \
PI_BENCH_TASKS=0,1,2 \
PI_BENCH_CONFIGS=extension \
PI_BENCH_RUNS=1 \
PI_BENCH_TIMEOUT_SEC=900 \
PI_BENCH_KEEP_WORKDIR=1 \
npm run benchmark:swe-pipeline-ab
```

`PI_BENCH_CONFIGS` can be `baseline,extension` (default, A/B comparison) or `extension` (skip baseline to save time/cost when iterating on the extension).

### Analyse session logs

After a benchmark run with `PI_BENCH_KEEP_WORKDIR=1`, inspect the extension's decisions and timeline:

```bash
npm run analyse-session -- /tmp/tmp.XXX/task_0/extension_run1/sessions/*.jsonl
```

Notes:
- Requires Docker running locally.
- By default it clones `DivyeshJayswal/SWE_ReBench` into the workdir for verifier code.
- This benchmark reports both efficiency metrics (latency/tokens/cost) and correctness (`resolved`).
