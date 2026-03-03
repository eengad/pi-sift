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

Only tasks where pi-sift made at least one decision are shown — zero-decision runs are uninformative about the extension.

| Instance | Decisions | B tokens | E tokens | Δ tokens | Δ cost | B tests | E tests |
|---|---|---|---|---|---|---|---|
| haystack-9527 | 1 | 204k | 151k | **-26%** | +31% | 25p/2f | 25p/2f |
| sympy-28122 | 1 | 499k | 274k | **-45%** | **-24%** | 101p/0f ✓ | 101p/0f ✓ |
| PyDough-368 | 6 | 4,075k | 2,649k | **-35%** | **-19%** | 127p/1f | 127p/1f |
| avroschema-870 | 3 | 913k | 977k | +7% | +22% | 14p/0f ✓ | 14p/0f ✓ |
| black-4676 | 1 | 53k | 71k | +34% | +81% | 144p/0f ✓ | 144p/0f ✓ |
| fromager-626 | 1 | 281k | 229k | -18% | +9% | 7p/0f ✓ | 6p/1f |

✓ = resolved. Single runs — variance applies, especially on 1-decision tasks. The three largest tasks (sympy, PyDough, haystack) show consistent token and cost reduction. black and fromager are likely noise: black's decision added overhead on a small task; fromager's decision fired at the last turn. Full results in [`benchmark-status.md`](./benchmark-status.md).

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

## Known issues

### Streaming flash of `<context_lens>` blocks
During streaming, `<context_lens>` blocks are briefly visible in the TUI before `message_end` strips them. Fixing in `message_update` is unsafe — the pi agent may rebuild message content from the stream buffer on each update (undoing mutations), and stripping before `message_end` would remove blocks before decision parsing runs. Cosmetic only; disappears when streaming completes.

## Links

- Design: [`DESIGN.md`](./DESIGN.md)
- Improvement ideas: [`IMPROVEMENTS.md`](./IMPROVEMENTS.md)
