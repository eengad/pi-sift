# Potential Improvements

## Rename to pi-sift
Rename the repo, package, and all references from `pi-context-lens` to `pi-sift`. Shorter, more memorable, implies filtering. Wait until no other sessions have this worktree open to avoid conflicts. Touches: GitHub repo name, `package.json` name field, README, DESIGN.md, IMPROVEMENTS.md, and any import/config references.

## Remove inline marker from tool_result hook
The `[CONTEXT_LENS_SCORE:id]` marker prepended in the `tool_result` hook (`src/index.ts` line 257) may be redundant. The scoring instruction injected via the `context` hook already lists each pending result with tool name, path, and size — enough for the model to identify them. Removing the marker would reduce context size. Blocked on having a reliable way to verify it doesn't degrade scoring accuracy.

## Consider scoring error results
Currently errors are unconditionally skipped (`src/index.ts` line 229). But long stack traces / compilation errors could benefit from summarization — the model doesn't always need the full output to debug. Also, after debugging, the error stays in context until compaction. Different behavior to design than normal results — needs its own approach.

## Auto-dismiss older read on re-read
Currently re-reads are skipped for scoring (`src/index.ts` line 238), but the older read result stays in context at full size. On re-read, the extension could automatically dismiss/summarize the previous result for that path, since the new content supersedes it.

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
Extend the current `seenFilePaths` tracking (which only covers `read` paths) to a general "same tool name + same parameters" signature. When the same tool call is made with identical arguments, keep only the most recent result and dismiss all earlier ones.

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
