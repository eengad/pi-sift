# pi-sift

A [Pi Coding Agent](https://github.com/nicepkg/pi-coding-agent) extension that prevents large and unnecessary tool results from polluting the context. The model scores large results for relevance and replaces low-value content with concise summaries, optionally preserving critical line ranges verbatim (`keepLines`).

## How it works

1. When a tool result exceeds a size threshold, pi-sift injects a scoring instruction as a separate user message asking the model to decide: **keep** or **summarize**.
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

## Benchmark

An A/B benchmark script is included for evaluating pi-sift on [SWE-ReBench](https://github.com/swe-bench/SWE-ReX) tasks. See [A/B benchmark](#ab-benchmark) below for usage. Early results with Claude Opus 4.6 show token reductions of 17–59% on tasks where the model makes scoring decisions, though single-run variance is high and more data is needed.

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

## Model compatibility

- **Claude Opus 4.6** — works well. The model follows scoring instructions reliably and uses `keepLines` effectively.
- **OpenAI Codex 5.3 (xhigh thinking)** — partially works. The model sees the scoring instruction (confirmed via debug logging) but only follows it ~33% of the time, skipping scoring and emitting tool calls instead. When it does follow, it produces valid summarize decisions. Tasks still resolve but with higher token usage than Opus.

## Known issues

### Streaming flash of `<context_lens>` blocks
During streaming, `<context_lens>` blocks are briefly visible in the TUI before `message_end` strips them. Fixing in `message_update` is unsafe — the pi agent may rebuild message content from the stream buffer on each update (undoing mutations), and stripping before `message_end` would remove blocks before decision parsing runs. Cosmetic only; disappears when streaming completes.

## Links

- Design: [`DESIGN.md`](./DESIGN.md)
- Improvement ideas: [`IMPROVEMENTS.md`](./IMPROVEMENTS.md)
