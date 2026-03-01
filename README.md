# pi-context-lens

`pi-context-lens` is a Pi Coding Agent extension that reduces context bloat by scoring large tool results and replacing low-value content with concise summaries in the LLM view.

Current status: **initial implementation (Mode A / piggyback) scaffold**.

- Design: [`DESIGN.md`](./DESIGN.md)
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

Optional overrides:

```bash
PI_BENCH_MODEL=openai-codex/gpt-5.3-codex \
PI_BENCH_TASKS=1,2 \
PI_BENCH_RUNS=1 \
PI_BENCH_TIMEOUT_SEC=900 \
PI_BENCH_VERIFY_TIMEOUT_SEC=900 \
PI_BENCH_KEEP_WORKDIR=1 \
npm run benchmark:swe-pipeline-ab
```

Notes:
- Requires Docker running locally.
- By default it clones `DivyeshJayswal/SWE_ReBench` into the workdir for verifier code.
- This benchmark reports both efficiency metrics (latency/tokens/cost) and correctness (`resolved`).
