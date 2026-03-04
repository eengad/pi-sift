# Benchmark Status

Model: `anthropic/claude-opus-4-6` | Dataset: `nebius/SWE-rebench-leaderboard` (693 tasks)

## Useful results (≥1 decision AND ≥1 test pass, N=1)

| Idx | Instance | B tokens | E tokens | Δ | Dec | Tests | B res | E res |
|-----|----------|----------|----------|---|-----|-------|-------|-------|
| 2 | haystack-9527 | 311k | 380k | +22% | 2 | 25p/2f | ❌ | ❌ |
| 6 | markdownify-230 | 155k | 143k | **-7%** | 2 | 50p/0f | ✅ | ✅ |
| 14 | trino-client-564 | 986k | 620k | **-37%** | 1 | 16p/0f | ✅ | ✅ |
| 16 | yt-dlp-13403 | 2,038k | 497k | **-76%** | 2 | * | ❌ | ✅ |
| 17 | persistent-220 | 286k | 270k | **-6%** | 1 | 361p/0f | ✅ | ✅ |
| 22 | PyDough-368 | 2,861k | 2,272k | **-21%** | 5 | 127p/1f | ❌ | ❌ |
| 25 | avroschema-870 | 1,381k | 573k | **-59%** | 3 | 14p/0f | ✅ | ✅ |
| 26 | opentelemetry-4614 | 444k | 579k | +30% | 1 | 9p/0f | ✅ | ✅ |
| 27 | black-4676 | 133k | 142k | +7% | 1 | 144p/0f | ✅ | ✅ |
| 29 | fromager-626 | 594k | 260k | **-56%** | 1 | 7p/0f | ✅ | ❌ |
| 31 | sympy-28137 | 401k | 491k | +22% | 3 | 163p/0f | ✅ | ✅ |
| 41 | pySHACL-285 | 471k | 461k | **-2%** | 2 | 5p/0f | ✅ | ✅ |
| 43 | alto-tools-29 | 55k | 70k | +28% | 1 | 2p/0f | ✅ | ✅ |

\* Task 16: baseline 0p/0f, extension 72p/0f — test parsing discrepancy, comparison unreliable.

**Summary (13 tasks with decisions, excluding task 16):**
- 8 tasks show token reduction (median -21%, range -2% to -59%)
- 4 tasks show token increase (median +22%, range +7% to +30%)
- 0 tasks where pi-sift broke a baseline-resolved task
- Resolution unchanged in 11 of 12 tasks; fromager: extension took different path

## Non-useful completed tasks (37)

| Idx | Instance | Reason |
|-----|----------|--------|
| 0 | pennylane-7671 | 0 decisions |
| 1 | conan-18444 | 0 decisions |
| 3 | stellarphot-519 | 0p/0f (Docker) |
| 4 | stellarphot-526 | 0p/0f (Docker) |
| 5 | venvstacks-197 | 0p/0f (Docker) |
| 7 | PyBaMM-5061 | 0p/0f (Docker) |
| 8 | Pillow-9023 | 0p/0f + 0 dec |
| 9 | sympy-28122 | 0 decisions |
| 10 | sqlglot-5189 | 0p/0f (verify) |
| 11 | sqlglot-5233 | 0p/0f (verify) |
| 12 | sqlglot-5253 | 0p/0f (verify) |
| 13 | sqlglot-5256 | 0p/0f + 0 dec |
| 15 | vyper-4677 | 0p/0f (Docker) |
| 18 | bqskit-337 | 0p/0f + 0 dec |
| 19 | scuba-269 | 0 decisions |
| 20 | anyio-935 | 0p/0f + 0 dec |
| 21 | biopython-5005 | 0 decisions |
| 23 | neuroconv-1406 | 0p/0f + 0 dec |
| 24 | geopandas-3591 | 0p/0f |
| 28 | trio-3280 | 0p/0f + 0 dec |
| 30 | pykern-578 | 0p/1f (no pass) |
| 32 | sympy-28183 | 0 decisions |
| 33 | GitPython-2051 | 0p/0f (Docker) |
| 34 | pymc-7809 | 0p/0f + 0 dec |
| 35 | plopp-459 | 0p/0f |
| 36 | reccmp-142 | 0p/0f + 0 dec |
| 37 | lmstudio-python-110 | 0p/0f + 0 dec |
| 38 | meilisearch-mcp-39 | 0p/0f |
| 39 | ome-zarr-models-py-206 | 0p/0f + 0 dec |
| 40 | python-control-1138 | 0p/0f |
| 42 | tardis-361 | 0p/0f |
| 44 | sqlglot-4661 | 0p/0f |
| 45 | sqlacodegen-371 | 0p/0f + 0 dec |
| 46 | mlx-vlm-179 | 0p/0f |
| 47 | xarray-9974 | 0p/0f + 0 dec |
| 48 | skore-1133 | 0p/0f |
| 49 | foamlib-329 | 0 decisions |

## Notes

- 50 tasks completed (indices 0-49), 13 useful (26% yield)
- High 0p/0f rate: many SWE-ReBench Docker images have broken dependencies
- N=1 per task — individual results subject to high variance
- Tasks with 0 decisions: pi-sift never triggered (all tool results < 5k chars threshold)
