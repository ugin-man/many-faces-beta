# Related work and contribution limits

This prototype does not claim to invent continuous nearest-neighbor search, candidate reranking, or distance-bound pruning.

## Baselines and metric scope

[Faiss index documentation](https://github.com/facebookresearch/faiss/wiki/Faiss-indexes) distinguishes exhaustive IndexFlatL2 from IndexHNSWFlat. Here both use the same fixed surrogate representation and the same strict-score reranker. Exact L2 search is exact only for that surrogate; the reference for the original composite score is exhaustive strict scoring.

[Faiss threading documentation](https://github.com/facebookresearch/faiss/wiki/Threads-and-asynchronous-calls) describes CPU thread controls. The experiment fixes numerical libraries to one thread and each measurement process to one CPU. It measures individual successive queries, not batched throughput.

## Existing continuous-query ideas

Zhengrong Yao, Like Gao, and Xiaoyang Sean Wang, *Using Triangle Inequality to Efficiently Process Continuous Queries on High-Dimensional Streaming Time Series*, SSDBM 2003, pp. 233–236, DOI [10.1109/SSDM.2003.1214985](https://doi.org/10.1109/SSDM.2003.1214985). The [proceedings listing](https://vldb.org/dblp/db/conf/ssdbm/ssdbm2003.html) confirms the bibliographic record. The indexed original abstract describes reusing prior query-to-pattern distances to exclude patterns for later queries. The full original PDF endpoint was unavailable during this review; its implementation was not reproduced or experimentally compared here.

Axel-Cyrille Ngonga Ngomo and Sören Auer, [*LIMES — A Time-Efficient Approach for Large-Scale Link Discovery on the Web of Data*](https://www.ijcai.org/Proceedings/11/Papers/385.pdf), IJCAI 2011, provides an accessible account of reference-point bounds and safe exclusion in a different application. It also cites the 2003 work. It is mathematical background, not a measured face-search competitor.

## What is specific to this artifact

The bound in [PROOF.md](PROOF.md) is derived component by component for the unchanged Many Faces score: weighted RMS/descriptor distances, maxima, and query-dependent wink coefficients. The full score is not assumed to be a metric.

The artifact adds a reproducible task definition, common scorer, causal temporal implementation, full-catalog reference, existing-library comparisons, fixed full-video/shuffled inputs, and correctness checks. Applying established bounds to this custom nonmetric score and observing a speedup do not by themselves establish publication-level novelty.

A strong claim of algorithmic advantage also needs stronger exact baselines, potentially fused native/SIMD scoring or existing exact indexes suited to the score, and inputs independent of the already-composited sample. The value of preserving the complete top 64 must be justified by the application, separately from retrieving only one similar face.