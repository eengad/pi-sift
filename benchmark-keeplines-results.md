# keepLines Benchmark Results

## Task 0: PennyLaneAI/pennylane-7671

| Metric | Baseline | Extension (keepLines) |
|---|---|---|
| Resolved | Yes | Yes |
| Elapsed | 146s | **62s** (-58%) |
| Total tokens | 91,432 | **68,561** (-25%) |
| Cost | $0.25 | **$0.20** (-20%) |
| Assistant msgs | 14 | **11** |
| Decisions | 0 | 1 |
| Passed tests | 729/729 | 729/729 |

Extension used a single `summarize + keepLines=[[130,144]]` on `prod.py`, preserving the exact `_remove_pauli_factors` bug area. No re-reads of kept content.

## Task 2: deepset-ai/haystack-9527

| Metric | Baseline | Extension (keepLines) |
|---|---|---|
| Resolved | No (25/27) | No (25/27) |
| Elapsed | 299s | **85s** (-72%) |
| Total tokens | 820,658 | **135,390** (-83%) |
| Cost | $0.56 | **$0.33** (-41%) |
| Assistant msgs | 33 | **16** |
| Decisions | 0 | 1 |
| Passed tests | 25/27 | 25/27 |

Extension used a single `summarize + keepLines=[[363,377],[447,467]]` on `super_component.py`, preserving `_to_super_component_dict` and `from_dict` methods. The decision survived re-reads and edits of the same file.

## Task 3: feder-observatory/stellarphot-519

| Metric | Baseline | Extension (keepLines) |
|---|---|---|
| Resolved | No | No |
| Elapsed | 681s | 725s (+6.5%) |
| Total tokens | 2,593,230 | 2,618,999 (+1.0%) |
| Cost | $2.14 | $2.56 (+19.5%) |
| Assistant msgs | 98 | 98 |
| Decisions | 0 | 7 |

Hard task (98 turns, 2.6M tokens). Model made 7 summarize decisions but never used keepLines. Spent ~30 turns in a pytest rabbit hole. Differences likely due to run variance rather than extension overhead.

## Task 4: feder-observatory/stellarphot-526

| Metric | Baseline | Extension (keepLines) |
|---|---|---|
| Resolved | No | No |
| Elapsed | 57s | **50s** (-12%) |
| Total tokens | 67,019 | **53,475** (-20%) |
| Cost | $0.16 | $0.18 (+11%) |
| Assistant msgs | 10 | 10 |
| Decisions | 0 | 1 |

Extension used `summarize + keepLines=[[37,38],[39,39]]` on a grep result, preserving the two key lines where `mag_inst` and `mag_error` are computed in `photometry.py`. Short task (10 turns) — token savings didn't offset scoring overhead, resulting in slightly higher cost.

## Totals (4 tasks)

| Metric | Baseline | Extension | Δ |
|---|---|---|---|
| Resolved | 1/4 | 1/4 | same |
| Elapsed | 1,183s | 922s | **-22%** |
| Total tokens | 3,572,339 | 2,876,425 | **-19%** |
| Cost | $3.11 | $3.27 | +5% |

## Notes

- Single runs per config — variance is possible
- Task 3 dominates totals (2.6M tokens) and likely reflects run variance, not extension overhead
- Baseline task 2 spent many messages on broad exploration and a testing rabbit hole
- Neither config resolves task 2 (2 tests always fail)
- Line numbers on scored tool results help the model make accurate keepLines selections
- Heuristic dismiss preserves summarize+keepLines decisions on re-read and edit
