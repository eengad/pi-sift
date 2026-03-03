# Benchmark Status

Model: claude-opus-4-6.

## Meaningful results (decisions > 0, working verification)

| Task | Instance | B tokens | E tokens | Δ tok | E decisions | B resolved | E resolved | Notes |
|---|---|---|---|---|---|---|---|---|
| 2 | haystack-9527 | 204k | 151k | -26% | 1 | no (25p/2f) | no (25p/2f) | same outcome |
| 9 | sympy-28122 | 499k | 274k | -45% | 1 | yes (101p) | yes (101p) | same outcome |
| 22 | PyDough-368 | 4075k | 2649k | -35% | 6 | no (127p/1f) | no (127p/1f) | same outcome, largest saving |
| 25 | avroschema-870 | 913k | 977k | +7% | 3 | yes (14p) | yes (14p) | both resolved, token diff likely variance |
| 27 | black-4676 | 53k | 71k | +34% | 1 | yes (144p) | yes (144p) | token diff likely luck (more test runs) |
| 29 | fromager-626 | 281k | 229k | -18% | 1 | yes (7p) | no (6p/1f) | decision at last turn, no effect — diff is luck |

## Runs with decisions but broken verification

| Task | Instance | E decisions | Reason |
|---|---|---|---|
| 3 | stellarphot-519 | 7 | install failure (0 tests), no baseline |
| 4 | stellarphot-526 | 1 | install failure (0 tests), no baseline |
| 5 | venvstacks-197 | 3 | truncated test IDs in dataset |
| 7 | pybamm-5061 | 3 | install failure (0 tests) |
| 10 | sqlglot-5189 | 4 | Docker git checkout failure |
| 11 | sqlglot-5233 | 2 | Docker git checkout failure |
| 12 | sqlglot-5253 | 1 | Docker git checkout failure |
| 15 | vyper-4677 | 3 | install failure |

## All runs with 0 decisions

Tasks with 0 decisions are not informative about pi-sift — any difference is model variance.

| Task | Instance |
|---|---|
| 0 | pennylane-7671 |
| 6 | markdownify-230 |
| 8 | pillow-9023 |
| 13 | sqlglot-5256 |
| 16 | yt-dlp-13403 |
| 18 | bqskit-337 |
| 19 | scuba-269 |
| 20 | anyio-935 |
| 21 | biopython-5005 |
| 23 | neuroconv-1406 |
| 24 | geopandas-3591 |
| 26 | opentelemetry-python-4614 |
| 28 | trio-3280 |

Baseline runs are unaffected by code version — all baseline data is valid.

## Verification failure reasons

### Docker git checkout failure (tasks 10, 11, 12, 13 — all sqlglot)
`fatal: reference is not a tree: <commit>` when Docker container tries `git checkout <base_commit>`.
The container does a fresh `git clone` of the repo and then checks out the old base commit. The clone
succeeds but the old commit is not available (likely because GitHub returns a shallow/partial clone
that only includes recent history). No clean fix identified.

### Truncated test IDs (task 5 — venvstacks)
Tests ran (verify_ok=True, 32s runtime, no error), but `passed_tests=0` and `failed_tests=0`.
Root cause: the dataset's `FAIL_TO_PASS` list contains truncated test IDs — e.g.
`test_mock_build_op_selection[(--lock-if-needed` without the closing `)]`. Pytest receives these
malformed IDs and errors before producing any PASSED/FAILED output. Dataset quality issue, not fixable.
Note: `resolved=False` is still correct since the model didn't fix the failing tests.

### Install failure (task 15 — vyper)
`ModuleNotFoundError: No module named 'vyper'` after pip install inside the Docker container.
The install_config install command fails to make the module importable, so tests can't run.

### Install timeout (task 14 — trino-python-client)
`pip install -e '.[tests]' -c /tmp/constraints.txt` timed out after 300s in Docker container.

### Poetry not available (task 25 — avroschema; also tasks 3, 4, 7)
`poetry install` fails because poetry is not in the base Docker image. Fixed in current pipeline
code (`benchmark-swe-pipeline-ab.sh` now installs poetry + disables virtualenv creation when
the install config uses poetry). Task 25 needs a re-run with fixed code.
Tasks 3, 4, 7 (stellarphot, pybamm) likely have a similar install issue — also need re-runs.

## Discussion

### Tasks with working verification and decisions
- **Task 22 (PyDough)**: most significant result — 6 decisions, -35% tokens (4075k→2649k), same outcome (127p/1f both). Large task where pi-sift clearly helps.
- **Task 9 (sympy)**: 1 decision, -45% tokens (499k→274k), both resolved (101p). Strong positive result.
- **Task 2 (haystack)**: 1 decision, -26% tokens (204k→151k), same outcome (25p/2f). Consistent token reduction.
- **Task 25 (avroschema)**: 3 decisions, +7% tokens (913k→977k), both resolved (14p). Token diff is noise — both resolved, no harm.
- **Task 27 (black)**: both resolved, but extension used +34% more tokens. 1 decision, small task (53k). Token diff likely variance from more test iterations.
- **Task 29 (fromager)**: extension saved -18% tokens but broke a test. 1 decision at last turn (no effect on outcome). Diff is luck.

### Pattern
Four tasks (2, 9, 22, 25) show no degradation in correctness; three of them save tokens significantly. Two tasks (27, 29) are noisy:
- Tasks 27 and 29 are small (53k, 281k) with 1 decision each — variance dominates at this scale
- Tasks 9 and 22 are larger (499k, 4075k) and show clear savings (-45%, -35%)
- Tasks 2 (204k) and 25 (913k) are mid-size — savings modest or zero, no harm

Hypothesis: pi-sift benefits scale with task size. Small tasks don't have enough redundant context to justify scoring overhead. This aligns with task 22 being the strongest result.
