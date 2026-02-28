# pi-context-lens — Design Plan

**Model-driven progressive context summarization for Pi coding agent**

## Problem

Current coding agents (Pi, Codex, Claude Code, OpenCode) accumulate every file read and tool result in the conversation history until compaction. A 500-line irrelevant file costs tokens on every subsequent turn — not just once, but N times across N turns until compaction finally kicks in. Beyond the raw token cost, irrelevant content in context actively degrades model performance: the model must attend to all context when predicting each token, and noisy/irrelevant content competes for attention with the actually relevant information, leading to worse reasoning and code generation. No agent currently has the model evaluate "is this relevant?" and immediately compress low-value content.

## Core Concept

After every `read`/`grep`/`bash` tool result, the model scores it for relevance to the current task and either keeps it in full, summarizes it, or dismisses it — before it accumulates in context.

The math: keeping an irrelevant file in context costs ~30x over a 30-turn session. A false negative (re-reading a dismissed file) costs 1x. Even with 10% false negatives, you're way ahead.

## Architecture

### Hook Point

`tool_result` event — intercepts results before they're added to conversation history (same hook RTK uses).

### Three-Tier Decision

The model classifies each tool result as:
- **keep** — highly relevant, keep full content
- **summarize** — partially relevant, replace with compressed version
- **dismiss** — irrelevant, replace with one-liner (e.g., "read `utils/legacy.ts` — deprecated helpers, not relevant")

### How the Model Scores (Two Modes)

**Default behavior: NO separate model call.**
Scoring runs in `mode: "piggyback"`, where the primary agent does scoring as part of its normal turn.
A separate model call is optional and only used in `mode: "external-model"`.

**Mode A — Piggyback (zero-cost, recommended default)**
- Scoring instructions are injected **conditionally, not permanently**. The `tool_result` hook sets a flag when a read/grep/bash result arrives **and the result exceeds a character threshold** (default: 2000 chars, configurable via `minCharsToScore`). Small files aren't worth the scoring overhead — a 50-line config file costs negligible context. The `before_agent_start` hook checks the flag and only appends scoring instructions to the system prompt for **the next agent loop iteration**. Flag is cleared after. This keeps the system prompt clean during turns with no tool results or only small reads.
- Note on timing: the flag is set during `tool_result` in iteration N, and picked up by `before_agent_start` in iteration N+1. This is the earliest the LLM can evaluate the content — it needs to see the result before it can score it.
- The injected instruction tells the agent to emit a structured `<context_lens>` block: `{action: "keep" | "summarize" | "dismiss", summary?: string, toolCallId: string}`
- At `message_end` (for the assistant message), the extension:
  1. Parses the `<context_lens>` block from the assistant response
  2. Strips the block from `event.message.content` (same object reference as in `state.messages`, so the mutation persists)
  3. Records the decision in an in-memory Map keyed by `toolCallId`
  4. Persists the decision via `pi.appendEntry("context_lens_decision", { toolCallId, action, summary })` for session reload survival
- On subsequent turns, the `context` event handler applies decisions: iterates through the cloned message array, replaces tool result content for any `toolCallId` found in the decision Map.
- On `session_start` (reload), the extension scans `ctx.sessionManager.getEntries()` for entries with `customType === "context_lens_decision"` and rebuilds the decision Map.
- **Why `context` event, not in-place mutation:** The extension API does not expose `agent.state.messages` to handlers. `ExtensionContext` provides only `ReadonlySessionManager`. The `context` event is Pi's designed mechanism for modifying the LLM's view — it receives a `structuredClone` of messages and returns modified ones. State is not affected.
- **Overhead:** The `structuredClone` is already done by Pi on every turn regardless. The extension adds only a Map lookup per tool result message in the clone — negligible. If no decisions exist yet, the handler returns immediately (fast path).
- Tradeoff: the full tool result is seen by the LLM for exactly one iteration (the scoring iteration) before being replaced in subsequent views. This is the minimum possible — you need at least one pass to score it.
- Cost: zero additional LLM calls — the agent is already reasoning about the content

**Mode B — External model call (decoupled scorer; quality/cost tradeoff)**
- After each tool result, call a separate scorer model with task description + tool result (can be cheap/fast or stronger, depending on config)
- Get back relevance score + optional summary
- Replace tool result content before it enters conversation
- Cost: extra request + extra output tokens + added latency; quality may be higher or lower than piggyback depending on scorer model choice

Start with Mode A (piggyback) — no extra API key, no extra latency, works with any single provider. Add Mode B (external model) as a config toggle for power users who have a cheap scorer key and prefer simpler architecture.

## Extension Structure

```
pi-context-lens/
├── index.ts          # Main extension factory: registers all hooks
├── prompt.ts         # System prompt injection for context scoring
├── decisions.ts      # Decision Map: in-memory store + rebuild from session entries
├── context.ts        # context event handler: applies decisions to cloned messages
├── parser.ts         # Parses <context_lens> blocks from assistant messages
├── scorer.ts         # External model scorer (Mode B)
├── config.ts         # User configuration
├── DESIGN.md         # Human-facing docs: philosophy, usage, how scoring works
└── package.json
```

## Configuration

`~/.pi/agent/context-lens.json`:
```json
{
  "enabled": true,
  "mode": "piggyback",
  "externalModel": "gpt-4o-mini",
  "enableReevaluation": false,
  "reevaluateAfterTurns": 3,
  "reevalOnTaskShift": true,
  "reevalOnContextPressure": false,
  "reevalTriggerContextUsage": 0.7,
  "reevalOnPreCompaction": false,
  "taskShiftConfidenceThreshold": 0.75,
  "reevalMaxItemsPerTurn": 2,
  "reevalMaxCharsPerTurn": 6000,
  "keepThreshold": 0.7,
  "tools": ["read", "grep", "bash"],
  "minCharsToScore": 2000,
  "preReadGateChars": 12000,
  "preReadPreviewLines": 120,
  "editedFileProtectionTurns": 4,
  "retainEditLedger": true,
  "excludePatterns": ["*.md", "AGENTS.md", "package.json"],
  "stats": true
}
```

## Scoring Prompt (injected dynamically via prompt.ts)

Instructs the agent to:
- After reading a file, assess its relevance to the current task
- Emit a `<context_lens>` block with your decision
- When summarizing, include: file path, key exports/functions found, why it matters (or doesn't)
- Bias toward summarize over keep — you can always re-read
- Never dismiss files you edited or plan to edit **within the active protection window** (recent turns); old edited files are eligible for re-scoring
- For grep results: keep if matches are in files you'll modify, summarize otherwise

## Key Design Decisions

1. **Default to summarize, not dismiss.** A one-line summary costs almost nothing but preserves the signal that the file exists and what it contains.

2. **Protect only recently active edited files (time-bounded).** Do **not** auto-summarize files the agent has edited or is about to edit **within a short protection window** (e.g., last 3-5 turns). Files edited long ago are re-evaluated like normal context and can be summarized/dismissed if irrelevant to the current feature. Track edits via `tool_execution_start` for write/edit tools.

3. **Very-long-file pre-read gate.** For very large files, do staged reading instead of full-read-first. Read a preview window first (first N lines + optional structural map), run relevance scoring, and only load the full file if the preview indicates high relevance. Structural map is **not** built into core Pi by default; the extension should generate one when possible (e.g., tree-sitter/ctags/regex outline) and gracefully fall back to preview lines only. This avoids paying full-context cost up front for likely irrelevant large files.

4. **Budgeted, trigger-gated re-evaluation (off by default).** Use **probable task switch** as the primary trigger (user asks for a clearly different objective). Keep context-pressure/pre-compaction triggers optional and disabled by default, since built-in compaction already handles hard pressure. Never run on every turn. Limit work per turn (e.g., max 2 items / 6000 chars) so re-evaluation cost is capped and predictable.

5. **Composability with RTK.** RTK strips syntactic noise (comments, ANSI, whitespace) first. context-lens evaluates semantic relevance on the already-cleaned output. They compose naturally.

6. **Escape hatch (no new tool).** If the agent needs previously summarized content, it should simply call the existing `read` tool again for that file (or range). No dedicated "restore" tool is needed.

## Implementation Phases

### Phase 1 — Piggyback mode (V1)
- `tool_result` → set scoring flag when result exceeds `minCharsToScore`
- `before_agent_start` → conditionally append scoring instructions to system prompt
- `message_end` → parse `<context_lens>` block, strip from assistant message, record decision in Map, persist via `pi.appendEntry()`
- `context` → apply decisions to cloned messages (fast path: skip if Map empty)
- `session_start` → rebuild decision Map from custom entries
- Protect recently edited files (skip scoring for files written/edited within last N turns)
- Fail-safe: on parse failure or malformed block, default to `keep`
- `dryRun` mode: log decisions without applying them
- Basic stats tracking (`/context-lens-stats` command)

### Phase 2 — External model mode (optional)
- `tool_result` hook with external scorer call (e.g., gpt-4o-mini)
- Requires user to configure a scorer API key
- Simpler architecture (one hook, no `context` event)
- A/B comparison mode to measure quality difference vs piggyback

### Phase 3 — Re-evaluation & advanced features
- Budgeted, trigger-gated re-evaluation of older "keep" results
- Protected file tracking refinements
- Batch evaluation (score multiple reads at once after an exploration burst)
- Integration testing with common workflows

## Prior Art

- **pi-rtk** — Rule-based syntactic token reduction (comments, ANSI, truncation). Complementary, not competing.
- **pi-context** — Git-like context management (tag/log/checkout). Agent-initiated, conversation-level. Different granularity.
- **pi-agentic-compaction** — Virtual filesystem for compacted context. Good for post-compaction recovery.
- **pi-readcache** — Read caching across compaction. Helps with false-negative re-reads.
- **pi-read-map** — Structural file outlines. Precursor to summarize-on-read.
- **Kimi CLI d-mail** — Time travel on session tree with summaries. Inspiration for pi-context.
- **ast-index** — AST-based code search. Attacks the "find right code before reading" problem instead.

## Implementation Detail: Block Stripping & Decision Persistence

The `<context_lens>` block emitted by the agent in its response must be stripped from the assistant message after parsing. Otherwise the scoring metadata itself accumulates in context, partially defeating the purpose.

**Flow (piggyback mode):**
1. `message_end` handler parses the `<context_lens>` block from `event.message.content`
2. Strips the block by mutating `event.message.content` (same JS object reference as in `state.messages` — this mutation affects both the in-memory state and what gets persisted by `appendMessage` immediately after)
3. Records `{ toolCallId, action, summary }` in an in-memory decision Map
4. Persists the decision via `pi.appendEntry("context_lens_decision", { toolCallId, action, summary })` — this is a separate JSONL entry that survives session reload
5. On future turns, `context` event handler replaces matching tool results in the cloned message array

**Flow (external model mode):**
1. `tool_result` handler calls external scorer with task description + tool result content
2. Returns `ToolResultEventResult` with modified `content` — the wrapper applies this BEFORE the result enters `state.messages` or gets persisted
3. Clean and simple — no `context` event needed, no per-turn overhead

**Key APIs (verified against Pi v0.54.2 source):**
- `tool_result` handler → returns `ToolResultEventResult { content?, details?, isError? }` — modifies result before it enters state (Mode B)
- `before_agent_start` handler → returns `{ systemPrompt? }` — replaces system prompt for the turn, chained across extensions
- `message_end` handler → void return, but `event.message` is same object reference as in state, so mutations to it persist
- `context` event → receives `structuredClone(messages)`, returns `{ messages }` — modifies LLM's view without affecting state (Mode A)
- `pi.appendEntry(customType, data)` → persists custom entries in JSONL session file
- `ctx.sessionManager.getEntries()` → read all entries including custom ones (for rebuild on reload)

**Session persistence model:**
- Session files are **append-only JSONL** — entries cannot be modified or deleted after writing
- `appendMessage(msg)` runs after `message_end` extension handlers, so assistant message mutations (block stripping) DO get persisted correctly
- Tool results are persisted at THEIR `message_end` (before the LLM scores them), so full content stays in the JSONL file permanently
- Decisions are persisted separately as custom entries — on reload, the extension rebuilds its Map and the `context` handler re-applies summaries

**Fork/branch behavior:** Since tool results remain full in JSONL, forks naturally get full content. The extension rebuilds decisions from custom entries along the branch path. Different branches can have different scoring decisions — correct behavior.

## Open Questions

- How well do current models follow the `<context_lens>` structured output instruction in practice? Needs empirical testing.
- Does the piggyback approach degrade the model's primary task performance (coding) by adding a secondary task (context scoring)?
- How should task-switch detection be implemented robustly (heuristics vs model judgment), and how do we avoid false positives on small scope changes?
- Is there any measurable quality gain from enabling context-pressure re-evaluation on top of existing compaction, or is it unnecessary complexity?

## Codex Review Verification (against Pi v0.54.2 source)

### Codex critical claims — verified

| Claim | Verdict | Details |
|-------|---------|---------|
| `before_agent_start` timing conflict | **Partially wrong** | Works across loop iterations. Flag in iteration N → picked up in N+1. |
| No "message transform hook" exists | **Wrong** | `context` event fires before every LLM call, receives `structuredClone(messages)`, can return modified messages. Comment in source: "Fired before each LLM call. Can modify messages." |
| Session history is append-only | **Correct** | JSONL append-only. Entries cannot be modified. `ExtensionContext` provides only `ReadonlySessionManager`. Extensions cannot access `agent.state.messages` directly. |
| "Zero-cost" piggyback is inaccurate | **Valid nuance** | Zero extra API calls is true, but scoring adds tokens (instructions + output block) and cognitive load. Plan wording ("zero additional LLM calls") is fair. |

### Codex recommendations — adopted

- **`toolCallId` in decisions** — Required for matching. Added to `<context_lens>` block schema.
- **Fail-safe: default keep** — On parse failure, timeout, or malformed block, always keep full content.
- **Decision persistence via `appendEntry`** — Required for session reload survival. `pi.appendEntry("context_lens_decision", ...)`.
- **Shadow mode (`dryRun`)** — Good for V1 rollout. Log decisions without applying them.
- **Smaller V1 scope** — Defer reevaluation, task-shift, pre-read gate to V2+.
- **Extension load order matters** — `tool_result` handlers chain in `for (const ext of this.extensions)` order. RTK runs before/after context-lens depending on load order. Document this.

### Codex recommendations — deferred or rejected

- **Token break-even model** — Interesting but complex for V1. Static `minCharsToScore` is sufficient to start.
- **Branch-aware state rebuild** — Handled naturally: custom entries follow the branch path via `getBranch()`, so different branches get different decisions.
- **"Remove claim that block can be stripped"** — Actually CAN be stripped: `message_end` handler mutates `event.message.content` (same object ref as state), and `appendMessage` runs after, so the stripped version persists.

---

*Plan created 2026-02-28 by Opus 4.6 and Eyal En Gad. Originated from a discussion about Pi agent architecture and context management gaps.*
