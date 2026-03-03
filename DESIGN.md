# pi-sift — Design Plan

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
- Scoring instructions are injected **conditionally, not permanently**. The `tool_result` hook marks results that exceed a character threshold (default: 5000 chars, configurable via `minCharsToScore`). Small files aren't worth the scoring overhead — a 50-line config file costs negligible context. The `context` hook checks for pending (unscored) results and appends a scoring instruction to the **last user message** (not as a separate message, to avoid TUI artifacts). This keeps the prompt clean during turns with no large tool results.
- Marked tool results are line-numbered (e.g., `1\tfunction hello() {`) so the model can specify precise `keepLines` ranges. For offset reads (e.g., `read foo.py` starting at line 200), line numbers start from the file offset, not 1.
- The injected instruction tells the agent to emit a structured `<context_lens>` block: `{action: "keep" | "summarize" | "dismiss", summary?: string, toolCallId: string, keepLines?: [[start, end], ...]}`
- At `message_end` (for the assistant message), the extension:
  1. Parses the `<context_lens>` block from the assistant response
  2. **Strips the block in-place** from `event.message.content` — this runs before TUI rendering and session persistence, so `<context_lens>` blocks never appear in the saved session or the user-visible display
  3. Records the decision in an in-memory Map keyed by `toolCallId`, including `lineOffset` for offset reads
  4. Persists the decision via `pi.appendEntry("context_lens_decision", { toolCallId, action, summary, keepLines, lineOffset })` for session reload survival
- On subsequent turns, the `context` event handler applies decisions: iterates through the cloned message array, replaces tool result content for any `toolCallId` found in the decision Map. For `summarize` with `keepLines`, the replacement includes a summary header plus `--- kept lines X-Y ---` sections with verbatim file content (line numbers stripped). The `lineOffset` ensures correct extraction when the original was an offset read.
- On `session_start` (reload), the extension scans `ctx.sessionManager.getEntries()` for entries with `customType === "context_lens_decision"` and rebuilds the decision Map.
- **Why `context` event, not in-place mutation:** The extension API does not expose `agent.state.messages` to handlers. `ExtensionContext` provides only `ReadonlySessionManager`. The `context` event is Pi's designed mechanism for modifying the LLM's view — it receives a `structuredClone` of messages and returns modified ones. State is not affected. (Exception: `message_end` does mutate `event.message.content` in-place for block stripping — this works because the message object reference is shared with state, and `appendMessage` runs after extension handlers.)
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
pi-sift/
├── src/
│   ├── index.ts          # Single-file extension: all hooks, scoring, decisions, context handling
│   ├── index.test.ts     # Unit and integration tests (64 tests)
│   └── validation.test.ts # Input validation tests
├── DESIGN.md
├── IMPROVEMENTS.md
├── README.md
└── package.json
```

## Configuration

`~/.pi/agent/pi-sift.json`:
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
  "minCharsToScore": 5000,
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

5. **Composability with RTK.** RTK strips syntactic noise (comments, ANSI, whitespace) first. pi-sift evaluates semantic relevance on the already-cleaned output. They compose naturally.

6. **Escape hatch (no new tool).** If the agent needs previously summarized content, it should simply call the existing `read` tool again for that file (or range). No dedicated "restore" tool is needed.

## Implementation Phases

### Phase 1 — Piggyback mode (V1) ✅ Done
- `tool_result` → mark results exceeding `minCharsToScore`, add line numbers (offset-aware), track for heuristic dismiss
- `context` → inject scoring instruction (appended to last user message) for pending results; apply decisions to cloned messages; strip `<context_lens>` blocks from all assistant messages
- `message_end` → parse `<context_lens>` block, **strip blocks in-place** (before TUI rendering and session persistence), record decision in Map (with `keepLines` and `lineOffset`), persist via `pi.appendEntry()`
- `session_start` → rebuild decision Map from custom entries
- Protect recently edited files (skip scoring for files written/edited within last N turns)
- Fail-safe: on parse failure or malformed block, default to `keep`; deterministic fallback after 2 assistant turns without a decision
- `dryRun` mode: log decisions without applying them
- Basic stats tracking (`/sift-stats` command)
- `keepLines` support: model can specify line ranges to preserve verbatim within a summarize decision
- Offset-aware line numbering: `lineOffset` persisted in decisions, `extractLineRange` uses it for correct file-relative indexing

### Phase 2 — External model mode (optional)
- `tool_result` hook with external scorer call (e.g., gpt-4o-mini)
- Requires user to configure a scorer API key
- Simpler architecture (one hook, no `context` event)
- A/B comparison mode to measure quality difference vs piggyback

### Phase 2.5 — Zero-cost heuristic strategies (partially done)
Deterministic strategies that require no LLM calls, inspired by [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning). These complement the model-driven scoring by handling cases where the right action is obvious from structure alone:
- ✅ Auto-dismiss older full read when the same file is re-read (offset reads are not dismissed — they may be complementary sections)
- ✅ Auto-dismiss reads after the file is edited (overrides existing model decisions since staleness is deterministic)
- Supersede-writes: dismiss write/edit inputs when the file is later read
- General dedup: same tool + same args → keep only the most recent result
- Purge error inputs after N turns (keep the error message, strip the input)
- Protected file patterns (glob-based never-prune list, implement `excludePatterns` from config)

See [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) for detailed descriptions and implementation notes.

### Phase 3 — Re-evaluation & advanced features
- Budgeted, trigger-gated re-evaluation of older "keep" results
- Protected file tracking refinements
- Batch evaluation (score multiple reads at once after an exploration burst)
- Integration testing with common workflows

## Prior Art

### Pi ecosystem

- **pi-rtk** — Rule-based syntactic token reduction (comments, ANSI, truncation). Complementary, not competing — no semantic/relevance judgment.
- **pi-context** — Git-like context management (tag/log/checkout). Agent-initiated, conversation-level. Different granularity.
- **pi-agentic-compaction** — Virtual filesystem for compacted context. Spawns a summarizer agent when compaction triggers. Conversation-level, not per-result.
- **pi-readcache** — Hash-based read caching across compaction. Returns "unchanged" markers for re-reads. Deduplication, not relevance scoring.
- **pi-read-map** — Structural file outlines for large files (tree-sitter). Precursor to the pre-read gate idea. Doesn't score or replace results.

### Other coding agents

- **OpenAI Codex CLI** — `context_manager/` + `compact.rs` + `truncate.rs`. Tool outputs are truncated by byte/token budget (blind size-based truncation). Conversation-level compaction via summarization prompt when context is full. No per-result relevance scoring.
- **Claude Code** — `/compact` command for conversation-level summarization. Hooks system (`PreToolUse`, `PostToolUse`, etc.) exists for guards/notifications but not for modifying tool result content or the model's context view. 100+ community plugins checked — none do per-result relevance scoring. Closest: `claude-mem` (cross-session memory compression), `claude-code-tools` (post-compaction context recovery).
- **Cline** — `ContextManager` does duplicate file read deduplication: when approaching context limits, replaces earlier reads of the same file with a note, keeping only the latest. Rule-based heuristic, not model-driven. Also does simple half/quarter truncation of old messages.
- **OpenCode** — `SummaryMessageID` field suggests conversation-level summarization. Minimal context management. MCP-based extensibility but no per-result scoring in core or known plugins (Context Analysis Plugin is reporting only, not pruning).
- **Aider** — `RepoMap` uses tree-sitter to build a repository symbol map for navigation. Doesn't evaluate individual tool results for relevance.

### Closest competitor: opencode-dynamic-context-pruning (DCP)

**[opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)** (1,000+ ⭐) is the most architecturally similar project. It provides model-driven context reduction for OpenCode through registered tools (`distill`, `compress`, `prune`) plus rule-based strategies (deduplication, supersede-writes, purge-errors).

**Key differences from pi-sift:**

| Aspect | DCP (OpenCode) | pi-sift (Pi) |
|--------|---------------|---------------------|
| **Mechanism** | Registers new tools the model must explicitly call | Piggyback — model scores inline as part of normal response |
| **Extra tool calls** | Yes — model makes separate distill/compress/prune calls | No — zero extra tool calls |
| **Timing** | Retroactive — model reviews accumulated context and decides what to prune | Proactive — each result scored before it accumulates across turns |
| **Trigger** | Agent-driven: model must recognize it should manage context, nudged periodically | Extension-driven: automatic on every large tool result |
| **Granularity** | Model picks from a `<prunable-tools>` list of past tool outputs | Per-result: each tool result scored as it arrives |
| **Rule-based strategies** | Dedup, supersede-writes, purge-errors (zero LLM cost) | Partial: auto-dismiss on re-read and edit (Phase 2.5); remaining strategies planned |
| **Conversation compression** | `compress` tool can collapse entire conversation ranges | Not in scope — focused on tool results only |

DCP validated the problem space but took a fundamentally different approach: it gives the model a context management toolkit and relies on the model to use it. Pi-sift forces automatic evaluation on every large result without requiring model initiative or extra tool calls.

### Other references

- **Kimi CLI d-mail** — Time travel on session tree with summaries. Inspiration for pi-context.
- **ast-index** — AST-based code search. Attacks the "find right code before reading" problem instead.

## Implementation Detail: Block Stripping & Decision Persistence

The `<context_lens>` block emitted by the agent in its response must be stripped from the assistant message after parsing. Otherwise the scoring metadata itself accumulates in context, partially defeating the purpose.

**Flow (piggyback mode):**
1. `tool_result` handler marks large results, adds offset-aware line numbers, tracks file paths for heuristic dismiss
2. `context` handler appends scoring instruction to the last user message for any pending (unscored) results; also strips `<context_lens>` blocks from all assistant messages and applies decisions to tool results
3. `message_end` handler parses the `<context_lens>` block from `event.message.content`, strips blocks **in-place** (before TUI rendering and session persistence), records `{ toolCallId, action, summary, keepLines, lineOffset }` in an in-memory decision Map
4. Persists the decision via `pi.appendEntry("context_lens_decision", { toolCallId, action, summary, keepLines, lineOffset })` — this is a separate JSONL entry that survives session reload
5. On future turns, `context` event handler replaces matching tool results in the cloned message array (with cached replacements for efficiency)

**Flow (external model mode):**
1. `tool_result` handler calls external scorer with task description + tool result content
2. Returns `ToolResultEventResult` with modified `content` — the wrapper applies this BEFORE the result enters `state.messages` or gets persisted
3. Clean and simple — no `context` event needed, no per-turn overhead

**Key APIs (verified against Pi v0.54.2 source):**
- `tool_result` handler → returns `ToolResultEventResult { content?, details?, isError? }` — modifies result before it enters state (used in Mode A for line numbering, Mode B for full replacement)
- `message_end` handler → void return, but `event.message` is same object reference as in state, so mutations to it persist (used for in-place `<context_lens>` block stripping)
- `context` event → receives `structuredClone(messages)`, returns `{ messages }` — modifies LLM's view without affecting state (used for scoring instruction injection, decision application, and block stripping)
- `pi.appendEntry(customType, data)` → persists custom entries in JSONL session file
- `ctx.sessionManager.getEntries()` → read all entries including custom ones (for rebuild on reload)

**Session persistence model:**
- Session files are **append-only JSONL** — entries cannot be modified or deleted after writing
- `appendMessage(msg)` runs after `message_end` extension handlers, so assistant message mutations (block stripping) DO get persisted correctly
- Tool results are persisted at THEIR `message_end` (before the LLM scores them), so full content stays in the JSONL file permanently
- Decisions are persisted separately as custom entries — on reload, the extension rebuilds its Map and the `context` handler re-applies summaries

**Fork/branch behavior:** Since tool results remain full in JSONL, forks naturally get full content. The extension rebuilds decisions from custom entries along the branch path. Different branches can have different scoring decisions — correct behavior.

## Provider-Specific: Compound Tool Call ID Canonicalization

Some LLM providers use compound tool call IDs — e.g. OpenAI Codex emits IDs like
`call_HDJ38HwQI28dDcWS8cIZpQzS|fc_00c30bd6ee2b86390169a75577cbc48191b62771fe65365125`.
Anthropic Claude uses simple IDs like `toolu_018GxcLKGdcansaszXbTdaV8`.

pi-sift stores decisions under a **canonical** (short) form: everything before the first
`|` pipe character (`call_HDJ38HwQI28dDcWS8cIZpQzS`). The scoring prompt also uses this
short form to keep token cost down. However, the model sees the **full compound ID** in
the conversation's `toolCall` and `toolResult` messages.

This mismatch caused a real bug: in Codex 5.3 benchmarks, the model received scoring
instructions referencing `call_XXX` but saw `call_XXX|fc_YYY` everywhere in context. It
couldn't match them, silently skipped scoring, and large reads (27k + 57k chars) sat
unscored for the entire session. The model's thinking even noted "Preparing context lens
block" but never emitted one — the ID mismatch made the instruction appear invalid.

**Fix:** The `context` hook canonicalizes all tool call IDs before sending messages to the
API — both `toolCall.id` in assistant messages and `toolResult.toolCallId`. This ensures
the model sees the same short IDs used in the scoring prompt. For providers with simple IDs
(no `|`), `canonicalToolCallId` is a no-op.

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
- **Extension load order matters** — `tool_result` handlers chain in `for (const ext of this.extensions)` order. RTK runs before/after pi-sift depending on load order. Document this.

### Codex recommendations — deferred or rejected

- **Token break-even model** — Interesting but complex for V1. Static `minCharsToScore` is sufficient to start.
- **Branch-aware state rebuild** — Handled naturally: custom entries follow the branch path via `getBranch()`, so different branches get different decisions.
- **"Remove claim that block can be stripped"** — Actually CAN be stripped: `message_end` handler mutates `event.message.content` (same object ref as state), and `appendMessage` runs after, so the stripped version persists.

---

*Plan created 2026-02-28 by Opus 4.6 and Eyal En Gad. Originated from a discussion about Pi agent architecture and context management gaps.*
