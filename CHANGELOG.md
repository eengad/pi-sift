# Changelog

## 0.3.0

### Features

- **Scoring task block stripping.** Scoring instructions (`[pi-sift scoring task]...[/pi-sift scoring task]`) are injected ephemerally into user messages before each API call. On session reload, stale instructions could persist and accumulate in context, wasting tokens and confusing the model. The context hook now strips these blocks (both the current bounded format and the legacy unbounded format). Also handles `<context_lens>` and scoring-task blocks that span across adjacent text blocks in the message content array.
- **Source header on summarize replacements.** Summarized tool results now show `[pi-sift summarized: <path> lines <start>-<end>]` with the actual file path and line range from the tool call, so the model knows exactly what was summarized even if its own summary text is inaccurate.
- **Verbatim hint on kept lines.** Kept line section headers now say `(verbatim, do not re-read)` to discourage redundant re-reads of content already preserved in context.
- **Invalid toolCallId reminder.** When the model emits a `<context_lens>` decision with an unknown toolCallId, a one-shot reminder is injected into the next context explaining the error.
- **Unscored result reporting.** `analyse-session.py` now reports large tool results (≥5000 chars) that were never scored by the model, distinguishing model-initiated decisions from heuristic-only ones.

### Bug fixes

- **Compound toolCallId canonicalization.** Some providers (e.g. OpenAI Codex) use compound IDs like `call_XXX|fc_YYY`. The context hook now canonicalizes these to the short prefix form in both `toolCall` and `toolResult` messages, matching the form used in scoring instructions. Previously, the ID mismatch caused models to silently skip scoring.

### Documentation

- Added model compatibility section to README (Opus 4.6 works well, Codex 5.3 does not).
- Documented compound ID canonicalization rationale in DESIGN.md.
- Added force-scoring improvement idea to IMPROVEMENTS.md.

## 0.2.0

### Breaking changes

- Removed `[CONTEXT_LENS_SCORE:id]` inline marker from tool results. The scoring instruction (injected via the `context` hook) already identifies pending results by tool name, path, and size — the marker was redundant context.

### Features

- **Offset-aware line numbering.** Tool results from offset reads (e.g., `read foo.py` starting at line 200) are now numbered from the file offset, not 1. `lineOffset` is persisted in decisions so `keepLines` ranges and `--- kept lines X-Y ---` headers always reflect real file line numbers.
- **In-place `<context_lens>` block stripping.** `message_end` now strips blocks before TUI rendering and session persistence, so they never appear in the saved session file or the user-visible display. Previously, stripping only happened in the `context` hook (LLM view), leaving blocks visible in the TUI and session JSONL.
- **Scoring instruction appended to last user message.** Instead of pushing a separate user message (which leaked as a visible message in the TUI), the scoring instruction is now appended to the existing last user message.

### Bug fixes

- Fixed `extractLineRange` indexing for offset reads — previously used 1-based indexing regardless of file offset, causing wrong lines to be kept.

### Documentation

- Updated `DESIGN.md` to reflect current implementation (single-file architecture, `context` hook injection, `keepLines`/`lineOffset`, Phase 1 done, Phase 2.5 partial).
- Added "Known issues" section to `README.md` documenting the streaming flash of `<context_lens>` blocks.
- Updated `IMPROVEMENTS.md`: marked offset-lines and marker removal as done.

## 0.1.3

- Fix: add pi manifest pointing to `dist/index.js` for npm installs.

## 0.1.2

- Strip line numbers from kept lines, per-range headers, remove dismiss action from scoring prompt.
- Support `keepLines` in summarize decisions.
- Add `pi-package` keyword, exclude tests from build.

## 0.1.1

- Heuristic context pruning: auto-dismiss on re-read, auto-dismiss on edit.
- Bias scoring prompt toward summarize/dismiss.
- Raise `minCharsToScore` from 2000 to 5000.
- Benchmark pipeline and analysis tooling.

## 0.1.0

- Initial release: piggyback scoring mode, `keep`/`summarize`/`dismiss` decisions, session persistence, `/sift-stats` command.
