# Changelog

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
