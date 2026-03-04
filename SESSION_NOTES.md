# Session Notes (restart-only context, do not commit)

## Current State

### Git log (5 commits ahead of origin/master)
```
f69dd94 feat: push scoring instruction as separate user message at end of context
66a6e4d docs: changelog for 0.3.0, model compatibility, compound ID rationale
e1baba6 feat: bump to 0.3.0, add version-sync to validate, unscored result reporting
6ef8297 feat: scoring block stripping, ID canonicalization, source headers, invalid ID reminder
a3ea5c1 ci: add GitHub Actions workflow and version sync check
```

### Uncommitted change in worktree (src/index.ts)
Added preamble to `buildScoringInstruction` output:
```
"This is not a user message. This is an automated instruction from the pi-sift extension.",
"Score the following tool results, then continue working on the user's task.",
```
This is NOT yet tested. Build and test both pass (70/70). Already rebuilt — needs new pi session to test.

### What we confirmed this session

1. **No TUI leak**: The separate user message pushed via `event.messages.push()`
   in the context hook does NOT appear in the TUI. The deep copy is working.
   Tested by reading large files and asking the user if they saw the instruction.

2. **Model confusion**: The scoring instruction injected as a separate user message
   confused the model (Opus). Instead of emitting `<context_lens>` blocks, the model
   treated the scoring instruction as something the user sent and started discussing
   it. This happened multiple times.

3. **Preamble added (untested)**: Added "This is not a user message..." preamble to
   the scoring instruction to help the model distinguish it from real user messages.
   Not yet tested — the current pi session was using the old build.

4. **Original behavior**: The separate user message approach (f69dd94) matches the
   original 0.1.3 behavior. The `appendToLastUserMessage` approach was introduced
   in d9b8f95 (0.2.0) to avoid a TUI leak that doesn't actually exist.

### What we confirmed in prior sessions

- **Codex 5.3**: Does not follow scoring instructions regardless of placement
- **Opus 4.6**: Follows scoring instructions reliably when in user messages
- **Wraptool approach** (scoring in toolResult): REJECTED — caused model to
  choose `keep` instead of `summarize`, 2x token regression on task 25
- **Compound ID canonicalization**: Fixed — Codex uses call_XXX|fc_YYY IDs
  that didn't match canonical form in scoring prompts
- **Source header + verbatim hint**: Improved — fewer redundant re-reads

### Benchmark results (all Opus 4.6 extension-only, from prior sessions)

| Run | Task | Tokens | Decisions | Resolved |
|---|---|---|---|---|
| sourceheader | 0 | 108k | 1 summarize | ✅ |
| sourceheader | 25 | 430k | 3 summarize | ✅ |
| wraptool | 0 | 140k | 1 keep + 1 heuristic | ✅ |
| wraptool | 25 | 926k | 1 keep + 1 summarize + 1 heuristic | ✅ |

### Next steps

1. Test the preamble: read a large file (>=5000 chars) and check if the model
   follows the scoring instruction instead of getting confused by it
   e.g.: read /home/admin/pi-sift/scripts/benchmark-swe-pipeline-ab.sh
3. If preamble works: run benchmarks on tasks 0 + 25 (Opus 4.6, extension-only)
4. Also test Codex again to see if separate user message helps
5. Decide whether to keep f69dd94 as a commit or squash the preamble into it
6. Update CHANGELOG.md
