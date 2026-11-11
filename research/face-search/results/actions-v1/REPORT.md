# Many Faces face-search benchmark: independent Actions run

**Validation: complete.** Every fixed method, order, repetition and query was checked against retained evidence.

This is a newly written analysis of the Actions run. It does not reconstruct missing local reports or combine hardware runs.

## Run

- Candidates: 70,000; valid queries: 1,011 of 1,061 decoded frames.
- Three sequential repetitions of original and fixed shuffled order.
- Python/Faiss: one thread on one logical CPU; the checked launcher applies the same affinity to Node.
- CPU: AMD EPYC 9V45 96-Core Processor
- Experiment commit: 8f5d19abc5c2089fceab6a0b8678562a7552fdb2
- Production score/source commit: ec97e233003e272cc203580953a180377945228d

## Results

Times include each implementation's timed search boundary and output assembly. Mean and p95 below describe the repeated fixed queries, not independent-video uncertainty.

### original

| Method | Mean ms | p95 ms | Recall@1 | Recall@10 | Recall@64 | Worst Recall@64 |
|---|---:|---:|---:|---:|---:|---:|
| exhaustive_strict | 56.086 | 61.429 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| temporal_exact | 23.608 | 58.429 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| faiss_flat_128 | 3.589 | 3.756 | 0.983185 | 0.932839 | 0.684888 | 0.218750 |
| faiss_hnsw_128 | 1.032 | 1.166 | 0.983185 | 0.932839 | 0.684950 | 0.218750 |
| faiss_flat_512 | 4.001 | 4.238 | 1.000000 | 0.989911 | 0.933389 | 0.593750 |
| faiss_hnsw_512 | 2.353 | 2.619 | 1.000000 | 0.989911 | 0.933389 | 0.593750 |
| faiss_flat_2048 | 6.141 | 6.539 | 1.000000 | 0.999407 | 0.994668 | 0.890625 |
| faiss_hnsw_2048 | 9.120 | 9.775 | 1.000000 | 0.999407 | 0.994668 | 0.890625 |
| faiss_flat_8192 | 14.267 | 15.463 | 1.000000 | 0.999901 | 0.999845 | 0.968750 |
| faiss_hnsw_8192 | 61.661 | 65.549 | 1.000000 | 0.999901 | 0.999845 | 0.968750 |
| current_node_core | 37.353 | 55.863 | 0.957468 | 0.927498 | 0.886406 | 0.000000 |

### shuffled

| Method | Mean ms | p95 ms | Recall@1 | Recall@10 | Recall@64 | Worst Recall@64 |
|---|---:|---:|---:|---:|---:|---:|
| exhaustive_strict | 55.620 | 60.836 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| temporal_exact | 54.607 | 61.545 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| faiss_flat_128 | 3.631 | 3.772 | 0.983185 | 0.932839 | 0.684888 | 0.218750 |
| faiss_hnsw_128 | 1.049 | 1.177 | 0.983185 | 0.932839 | 0.684950 | 0.218750 |
| faiss_flat_512 | 4.023 | 4.240 | 1.000000 | 0.989911 | 0.933389 | 0.593750 |
| faiss_hnsw_512 | 2.350 | 2.598 | 1.000000 | 0.989911 | 0.933389 | 0.593750 |
| faiss_flat_2048 | 6.121 | 6.485 | 1.000000 | 0.999407 | 0.994668 | 0.890625 |
| faiss_hnsw_2048 | 9.047 | 9.666 | 1.000000 | 0.999407 | 0.994668 | 0.890625 |
| faiss_flat_8192 | 14.137 | 14.985 | 1.000000 | 0.999901 | 0.999845 | 0.968750 |
| faiss_hnsw_8192 | 61.003 | 65.003 | 1.000000 | 0.999901 | 0.999845 | 0.968750 |
| current_node_core | 40.837 | 58.345 | 0.957468 | 0.927498 | 0.886406 | 0.000000 |

## Preparation and interpretation

Per-repeat descriptor construction, embedding/index build times, index sizes and memory observations are retained in summary.json. They are not hidden inside the search-time comparison.
Per-query metrics in per-query-metrics.csv.gz contain no face IDs, photos or landmark coordinates. All quality metrics are recomputed from private retained match arrays.
Node detailed-candidate counts are available only at pass level; they are not invented as per-query scoring counts.

## Limitations

- This is a new independent hardware run. No numbers from the interrupted local run are pooled.
- These Python timings rotate all methods within each query; predecessor/cache effects may remain. Keep standalone isolated-control timings separate.
- There is one already-composited public video. Its frames and timing repetitions are not independent videos or perceptual ground truth.
- Recall measures agreement with the fixed strict-score global top-64; it does not measure identity recognition or human-perceived similarity.
- Search timings exclude video inference, input reads, descriptor/index construction and rendering; preparation is reported separately.
- The Node baseline is only the warm production search core. Wink supplements, quality overlays, browser scheduling and sequence optimization are excluded.
- Python and Node are implemented systems in different runtimes. No speed ratio establishes a language-independent algorithmic advantage.
- The exactness observations do not establish new research novelty or superiority over optimized native fused exact-search baselines.
- Aggregate percentiles pool repeated observations of the same fixed queries; no confidence intervals or population-level significance are claimed.

The standalone isolated control is a separate experiment. Its timings must not be pooled into these tables.
