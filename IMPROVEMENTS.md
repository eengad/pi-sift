# Potential Improvements

## Make kept-lines headers clearer to reduce redundant re-reads
The model sometimes re-reads line ranges that are already preserved verbatim via keepLines. For example, in haystack the model kept lines 363-467 but later re-read 363-413 (fully within the kept range). The current header `--- kept lines 363-467 ---` doesn't make it obvious that these lines are still available in context. Consider a more explicit header like `--- file lines 363-467 (verbatim, still in context — no need to re-read) ---`.

## ~~Kept-lines headers should show file line numbers, not tool-result-relative numbers~~ ✅ Done
Tool results from offset reads are now numbered starting from the file offset (e.g., `200\tline content`), and `lineOffset` is persisted in decisions. `extractLineRange` adjusts indexing so keepLines values and `--- kept lines X-Y ---` headers always reflect real file line numbers. Unit-tested; manually verified in live pi session (offset read from line 400 produced correct file-relative headers).

---

## ~~Rename to pi-sift~~ ✅ Done
Renamed from `pi-context-lens`. Internal protocol strings (`<context_lens>`, `context_lens_decision`) kept as-is for session compatibility.

## ~~Auto-dismiss full-file reads on re-read~~ ✅ Done
When the agent re-reads a file, the old full-file read is dismissed automatically. Only applies to `read` tool (not grep/bash). Offset reads don't dismiss each other since they may be complementary sections. Small results (below `minCharsToScore`) are not tracked.

## ~~Auto-dismiss reads after the file is edited~~ ✅ Done
When the agent edits a file, any earlier read of that file is dismissed as stale. Overrides existing model decisions (e.g. "keep") since staleness is deterministic.

## ~~Bias scoring toward summarize/dismiss~~ ✅ Done
Added prompt text: "Prefer summarize or dismiss — keeping costs tokens every turn; re-reading is cheap." The model still tends toward keep in practice — may need stronger intervention (e.g. removing keep as an option).

## ~~Raise minCharsToScore threshold~~ ✅ Done
Raised from 2000 to 5000. Small targeted reads (agent already curated the range via grep) have marginal savings that don't justify scoring overhead.

---

## Force scoring before continuing

When the model ignores the scoring instruction (responds with only tool calls, no `<context_lens>` block), the large tool result sits unscored in context indefinitely. This was observed consistently with Codex 5.3 and occasionally with Opus 4.6.

The current fallback (apply `keep` after 2 text-bearing turns) rarely fires because most intermediate turns are tool-call-only, and `keep` provides no compression anyway.

Possible approaches:
- **Withhold next tool result**: intercept the next `tool_result` and replace it with a message demanding scoring first. Aggressive — could slow or confuse the model.
- **Synthetic user turn**: inject a user message before the next API call that only contains the scoring instruction, forcing a text response. Intrusive — adds a visible turn.
- **Count all turns** (not just text-bearing) toward the fallback threshold. Wouldn't force scoring but would at least resolve pending state sooner.

None of these are great. Opus scores reliably enough that this isn't urgent, but it's the main gap for non-Anthropic models.

## Fork-based A/B benchmarking
The current independent-runs A/B approach has high variance (model runs can differ 20-30% in tokens
with no changes). A fork approach would snapshot the session at the first large tool result, then run
one branch with compression and one without. This isolates the decision's actual impact rather than
conflating it with run-to-run variance. Non-trivial to implement: requires injecting the full
uncompressed tool result back into the baseline branch at the fork point.

## ~~Remove inline marker from tool_result hook~~ ✅ Done
The `[CONTEXT_LENS_SCORE:id]` marker has been removed. The scoring instruction injected via the `context` hook already lists each pending result with tool name, path, and size — enough for the model to identify them.

## Consider scoring error results
Currently errors are unconditionally skipped. But long stack traces / compilation errors could benefit from summarization — the model doesn't always need the full output to debug. Also, after debugging, the error stays in context until compaction. Different behavior to design than normal results — needs its own approach.

## Edited files may have been read before editing
Recently edited files may already be covered by re-reads and maybe don't need a separate condition to be skipped from scoring.

---

## Zero-cost heuristic strategies (inspired by DCP)

The following are deterministic strategies that require no LLM calls. They run in the `context` handler alongside existing decision-application logic and complement the model-driven scoring.

See [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) for the OpenCode implementations of similar ideas.

### Supersede-writes
When a file is written/edited and later read, the write's input content is redundant — the read result has the current file state. Automatically dismiss the old write/edit tool input on the read.

This is the complement of "Auto-dismiss older read on re-read" above. Together they cover both directions:
- Old write → later read of same file → dismiss write input
- Old read → later re-read of same file → dismiss old read result

Implementation: track `(path, toolCallId)` for write/edit calls in `tool_execution_start`. In the `context` handler, when a read result for the same path exists later in the conversation, replace the write's input content with a placeholder like `[write input superseded by later read of same file]`.

### Purge error inputs after N turns
After a configurable number of turns (e.g., 4), strip the *input* content of errored tool calls while keeping the error message. The potentially large command/file content that triggered the error is no longer useful for debugging after the agent has moved on.

This is a simpler first step for the "Consider scoring error results" item above — pure heuristic, no model judgment needed.

Implementation: track errored tool calls with their turn number. In the `context` handler, for errors older than N turns, replace the input content with `[input removed — error tool call from N turns ago]`.

### General dedup (same tool + same args → keep only latest)
When the same tool call is made with identical arguments, keep only the most recent result and dismiss all earlier ones.

Covers cases the current re-read logic misses:
- Running `npm test` twice (before and after a fix)
- `grep` with the same pattern re-run after edits
- `bash` commands re-executed to verify a change

Implementation: hash `(toolName, JSON.stringify(sortedArgs))` as a signature. Maintain a `Map<signature, toolCallId>` of the latest call per signature. In the `context` handler, replace older results for the same signature with `[superseded by later identical tool call]`.

### Protected file patterns (glob-based never-prune list)
Allow users to configure glob patterns for files that should never be summarized or dismissed, regardless of the model's scoring or turn-based protection.

Use case: key entry points, config files, or actively-worked-on files that the user always wants in full.

Already in the config spec as `excludePatterns` but not yet implemented. DCP calls this `protectedFilePatterns`.

Implementation: check file paths against configured glob patterns in the `tool_result` hook, before marking for scoring. Files matching any pattern skip scoring entirely (same as the current edited-file protection path).
