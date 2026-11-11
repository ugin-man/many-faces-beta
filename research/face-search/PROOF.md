# Conservative temporal reuse for the fixed strict score

This note describes the pruning condition used by `temporal_exact.py`. It is an
application of norm distance bounds, maxima, and triangle inequalities to the
existing Many Faces score. It does not claim that these general mathematical
ideas are new. Numerical behavior and retrieval speed require measurement.

## Scope and notation

Let `S(q,c)` be `projectionError(q,c).strictTotal` with one fixed roll compensation
policy, query `q`, and candidate `c`. Queries and candidates contain finite
55-component feature vectors and 468 normalized 2-D landmarks. Descriptor
preparation uses the existing production definitions and fixed weights.

The evaluation target is the global top-k of this scalar score. The production
application additionally uses pose windows, candidate gates, specialist pools,
and sequence selection; they are not part of this proof.

The algorithm stores scores `S(a,c)` for every candidate at a *past anchor query*
`a`, obtained by an exhaustive scan. It seeks a candidate-independent bound

`|S(q,c) - S(a,c)| <= L(q,a)`.

The full strict score is asymmetric because some coefficients depend on the
query's wink activity. We do **not** assume it is a metric.

## Bounds for the symmetric component distances

The contour, mouth, left-eye, right-eye, brow, and nose terms are Euclidean RMS
distances on fixed landmark groups. The mouth, eye, and brow descriptor distances
are weighted Euclidean distances after a deterministic descriptor mapping. The
blendshape and mouth-action terms are also weighted Euclidean distances.

For any such component `d`, the reverse triangle inequality gives

`|d(q,c) - d(a,c)| <= d(q,a)`.

Nonlinearity of the descriptor mapping does not invalidate this inequality:
the inequality is used *after* mapping all three faces into the same space.

The mouth-shape term is `0.62*d_mouth_geometry + 0.38*d_mouth_action`, a positive
sum of these distances. Its query-change bound is therefore its own value
between `q` and `a`.

The eye term is `max(d_left_eye, d_right_eye)`. Using

`|max_i x_i - max_i y_i| <= max_i |x_i-y_i|`,

its query-change bound is `max(d_left_eye(q,a), d_right_eye(q,a))`.

The blink term is the L-infinity distance between the two clipped blink channels
and obeys the same reverse triangle inequality. The normalized pose distance is
Euclidean distance on the fixed pose coordinates (with roll either omitted or
scaled by 0.35), and the pitch term is absolute normalized pitch difference.
If the roll policy changes, the implementation performs a new exhaustive scan
instead of applying a bound between different scoring functions.

Consequently, the existing shape-gate value between `q` and `a` bounds changes
in shape gate for every candidate:

`G(q,a) = 0.62*d_contour + 0.20*d_nose + 0.08*d_pose + 0.10*d_pitch`.

## Query-dependent wink coefficients

Write `w(q) = clip(blink_left(q)) - clip(blink_right(q))`, so every `w` lies in
`[-1,1]`. Define `A(q) = clip((|w(q)|-0.14)/0.42, 0, 1)`.

A query-weighted wink term has the form

`T(q,c) = alpha(q)*|w(q)-w(c)|`,

where `alpha(q) = b + m*A(q)` and `b,m` are nonnegative constants. Adding and
subtracting `alpha(q)*|w(a)-w(c)|` gives

`|T(q,c)-T(a,c)|`

`<= alpha(q)*||w(q)-w(c)|-|w(a)-w(c)||`

`   + |alpha(q)-alpha(a)|*|w(a)-w(c)|`

`<= (b+m*A(q))*|w(q)-w(a)|`

`   + m*|A(q)-A(a)|*(1+|w(a)|)`.

Denote this last quantity by `B(b,m;q,a)`. It is independent of `c`. The wink
term inside the local maximum uses `B(0.42,0.58;q,a)`; the final additive wink
term uses `B(0.12,0.48;q,a)`.

Ignoring coefficient changes would be unsafe near the wink activation region.
The extra activity-change term is therefore retained even when it makes pruning
ineffective.

## Bound on the complete score

The local maximum's query-change bound `W(q,a)` is the maximum of these eleven
quantities, evaluated between the current query and the anchor:

1. `1.15*d_mouth`
2. `1.60*d_left_eye`
3. `1.60*d_right_eye`
4. `1.20*d_brows`
5. `0.48*d_mouth_descriptor`
6. `0.95*d_mouth_shape`
7. `0.52*d_eye_descriptor`
8. `0.40*d_brow_descriptor`
9. `0.16*d_blendshape`
10. `0.42*d_blink`
11. `B(0.42,0.58;q,a)`

Applying the triangle inequality to the fixed positive weighted sum in
`strictTotal` then gives the uniform bound

`L(q,a) = 0.23*G(q,a) + 0.54*W(q,a)`

`         + (0.08/3)*(d_mouth(q,a)+d_eyes(q,a)+d_brows(q,a))`

`         + 0.15*d_pitch(q,a) + B(0.12,0.48;q,a)`.

This establishes `|S(q,c)-S(a,c)| <= L(q,a)` in real arithmetic.

## Safe candidate rejection and stable ties

First evaluate the anchor's k best candidate IDs using the *current* query.
Let `U` be the largest current score among those k distinct candidates. The
current global kth score is at most `U`, regardless of how poor the anchor's
neighbors have become.

For any other candidate,

`S(q,c) >= S(a,c)-L(q,a)`.

Thus a candidate with `S(a,c)-L(q,a) > U` cannot enter the current global top-k.
Candidates with an equal lower bound are retained. The implementation scores
every retained candidate using the same common strict scorer and resolves ties
by canonical candidate-ID order. Seed results are reused inside that call;
they are not blindly copied from the anchor.

If more than 60% of the database remains eligible, a full scan refreshes the
anchor. The threshold is a fixed efficiency policy, not a correctness condition.
The full scan obtains scores for *every* candidate before replacing the anchor.
If seed candidates were already scored, their additional evaluations are
reported in the work counter, even though the full scan recomputes them.

## Causality, cost, and failure cases

The first query after reset is exhaustive. At later queries only the current
query, one past anchor, and the fixed database are read. The method does not
inspect later frames, skip queries, or reuse the final query from a previous
benchmark pass. `reset()` is required at each clip/order/pass boundary.

Each query scans an N-element scalar anchor-score array and fully evaluates only
the eligible faces, except on refreshes. Extra persistent state is N float64
anchor scores plus k integer IDs, excluding shared prepared descriptors.
Large head movements, winks with changing activity coefficients, abrupt cuts,
or dispersed queries can require exhaustive scoring repeatedly. This is an
expected adverse case; it must remain in the result set.

## Floating-point qualification

The proof above is for real arithmetic. NumPy reductions and hypot are float64
operations and have rounding error. The implementation includes a margin

`epsilon = 1e-10 * max(1, max_c |S(a,c)|, |L|, |U|)`

and retains `S(a,c) <= U+L+epsilon`. This margin is intentionally larger than the
observed scalar-JavaScript/NumPy port discrepancy, but it is not a formally
verified interval-arithmetic proof for all representable inputs. Nonfinite
scores cause a failure; a nonfinite change bound falls back to a full scan.
`verify_temporal_exact.py` independently compares the bound and returned results
with exhaustive scoring, including real data and explicit synthetic boundary
cases. Experimental exact agreement must be reported as observed agreement,
not as an unconditional hardware-level guarantee.
