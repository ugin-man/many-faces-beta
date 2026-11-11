# Isolated exact-search diagnostic

Status: **complete and validated**. All six fixed fresh-process passes are retained.

This implementation was authored anew after the original cloud environment became unavailable. It is a post-observation diagnostic, not preregistration. The interrupted host's measurements are not included. The main interleaved experiment and this standalone condition remain separate.

## Measurement and validation

- Database: 70,000 canonical candidates.
- Each pass: all 1,011 valid queries from the fixed existing clip; top 64.
- Schedule: original E, T, T, E in four new processes; shuffled T, E in two new processes.
- Each process constructs only its measured engine, performs three database-derived warmups, resets history, and measures one complete pass. No Faiss index is constructed.
- Timers include query preparation, search, top-k, history maintenance, and conversion of returned indexes/scores to lists. Decode, inference, candidate preparation, warmup and oracle validation are excluded.
- Every returned candidate ID and rank equals the frozen saved main oracle; every score has absolute error at most 2e-12, with relative tolerance zero. No competing scorer runs to grade a query.
- CPU affinity: [0]; numerical/Faiss threads: 1.
- CPU model: AMD EPYC 9V45 96-Core Processor.

## Complete timing results

| Order | Engine | Passes | Mean ms | p50 ms | p95 ms | Max ms | Recall@64 | Min recall@64 | Full scans | Mean scored |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| original | exhaustive_strict | 2 | 54.882579 | 54.278505 | 58.270917 | 107.452582 | 1.000000 | 1.000000 | 2022 | 70000.00 |
| original | temporal_exact | 2 | 23.302564 | 16.085873 | 57.281836 | 102.777330 | 1.000000 | 1.000000 | 472 | 24920.62 |
| shuffled | exhaustive_strict | 1 | 55.015820 | 54.270271 | 58.534883 | 103.512525 | 1.000000 | 1.000000 | 1011 | 70000.00 |
| shuffled | temporal_exact | 1 | 54.717553 | 56.159890 | 59.574070 | 111.197185 | 1.000000 | 1.000000 | 944 | 67132.44 |

Original-order results have two repetitions per engine; shuffled-order results have only one supplementary repetition per engine. These are observations on one already-composited clip. They support no confidence interval, significance claim, cross-video generalization, identity-recognition accuracy claim or proof of human perceptual similarity.

## Ratios and every pass

- original: exhaustive total / temporal total = 2.355216; temporal measured-time reduction = 57.541%. Repetitions per engine = 2.
- shuffled: exhaustive total / temporal total = 1.005451; temporal measured-time reduction = 0.542%. Repetitions per engine = 1.

| Pass | Order | Engine | Repeat | Total ms | Mean ms | Read s | Descriptors s | Warmup s | Peak RSS bytes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | original | exhaustive_strict | 0 | 55153.636848 | 54.553548 | 0.326196 | 0.208563 | 0.167617 | 969924608 |
| 1 | original | temporal_exact | 0 | 23678.198450 | 23.420572 | 0.333481 | 0.208722 | 0.171633 | 978165760 |
| 2 | original | temporal_exact | 1 | 23439.584997 | 23.184555 | 0.332665 | 0.213567 | 0.171428 | 977920000 |
| 3 | original | exhaustive_strict | 1 | 55818.938013 | 55.211610 | 0.331457 | 0.213547 | 0.167981 | 969863168 |
| 4 | shuffled | temporal_exact | 0 | 55319.446456 | 54.717553 | 0.335122 | 0.209456 | 0.168896 | 977661952 |
| 5 | shuffled | exhaustive_strict | 0 | 55620.993958 | 55.015820 | 0.341088 | 0.209948 | 0.167640 | 969887744 |

## Main-run predecessor diagnostic

Cyclic rotation changes positions but preserves most exhaustive-to-temporal adjacency. Strata contain different queries and are observational, not a causal estimate. Standalone control also removes competing ANN allocations; it does not isolate cache effects alone.

The cyclic main experiment is not fully counterbalanced. Standalone speed claims should refer to the isolated results above. The following strata are displayed to make the timing concern reviewable; they are not adjustments applied to either experiment.

| Order | Prior method within query | Temporal full scan | Count | E mean ms | T mean ms | E/T paired totals |
|---|---|---|---:|---:|---:|---:|
| original | exhaustive_strict | False | 2087 | 56.063235 | 13.355992 | 4.197609 |
| original | exhaustive_strict | True | 642 | 56.229257 | 57.381332 | 0.979922 |
| original | first_in_query_group | False | 238 | 56.013859 | 13.199862 | 4.243519 |
| original | first_in_query_group | True | 66 | 55.674947 | 56.776458 | 0.980599 |
| shuffled | exhaustive_strict | False | 174 | 55.585382 | 28.959190 | 1.919438 |
| shuffled | exhaustive_strict | True | 2555 | 55.632106 | 56.436734 | 0.985743 |
| shuffled | first_in_query_group | False | 27 | 54.851713 | 31.342101 | 1.750097 |
| shuffled | first_in_query_group | True | 277 | 55.602181 | 56.110721 | 0.990937 |

## Evidence and limits

The accompanying summary contains immutable source/input/oracle hashes, runtime versions, every pass, aggregate tails, candidate counts and full-scan counts. The public compressed CSV contains numeric query metrics only. Full ordered candidate IDs and strict-score arrays remain in private matches.npz files under the raw work directory and are not uploaded as public artifacts.

The unchanged primary score is the correctness target. Its empirical agreement with the production port does not establish a new similarity metric or a new nearest-neighbor theorem. The pruning argument is exact in real arithmetic; this run checks the implementation's floating-point margin on every selected query and candidate result.

This condition uses a fresh process per engine and no competing ANN indexes. Consequently, differences from the main experiment may include allocator, memory-footprint and cache effects. The E/T/T/E order limits a simple linear drift explanation but does not eliminate host contention, thermal drift or general hardware variability.
