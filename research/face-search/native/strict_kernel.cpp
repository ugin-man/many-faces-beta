// Fused float64 evaluation of the frozen Many Faces strictTotal score.
// This is an implementation baseline, not a different similarity function.
// Prepared descriptor definitions remain in ../strict_metric.py.
// Build without fast-math and with floating-point contraction disabled.

#include <algorithm>
#include <cmath>
#include <cstdint>

extern "C" {

struct MFPreparedFaces {
    std::int64_t count;
    const double* features;      // [count, 55]
    const double* contour;       // [count, 72]
    const double* mouth;         // [count, 62]
    const double* left_eye;      // [count, 32]
    const double* right_eye;     // [count, 32]
    const double* brows;         // [count, 40]
    const double* nose;          // [count, 36]
    const double* expression;    // [count, 8]
    const double* mouth_shape;   // [count, 8]
    const double* blinks;        // [count, 2]
};

int mf_strict_abi_version() noexcept { return 1; }

}  // extern "C"

namespace {

constexpr int kComponentCount = 23;
constexpr int kMouthIndexes[24] = {
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 38, 39,
    40, 45, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51,
};
constexpr double kMouthWeights[24] = {
    3.2, 1.1, 4.6, 4.8, 1.3, 1.3, 1.0, 1.0, 3.2, 3.2, 1.1, 1.1,
    0.8, 0.8, 1.5, 1.5, 0.8, 0.8, 1.2, 1.2, 1.0, 1.0, 1.5, 1.5,
};
constexpr double kBlendWeights[51] = {
    2.8, 0.5, 0.9, 1.0, 3.1, 3.1, 1.4, 1.4, 0.8, 0.8, 2.7, 2.7,
    1.1, 1.1, 1.35, 1.0, 1.0, 1.0, 1.0, 0.35, 0.35, 0.35,
    1.35, 1.35, 0.35, 0.35, 0.35, 0.35, 1.35, 1.35, 2.2, 2.2,
    0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35,
    0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.85, 0.85,
};
constexpr double kShapeWeights[8] = {2.2, 2.8, 4.2, 1.8, 4.4, 1.5, 2.2, 2.2};
constexpr double kExpressionWeights[4] = {2.6, 1.8, 0.7, 2.4};

inline double square_difference(double query, double candidate) noexcept {
    const double delta = candidate - query;
    return delta * delta;
}

// Independent accumulators limit a single long dependency chain. Reassociation
// is explicit here; compiler fast-math must not silently change other formulas.
// The finite numerical checks compare every exposed component with NumPy.
template<int Width>
inline double grouped_sum(const double* query, const double* candidate) noexcept {
    static_assert(Width >= 8 && Width <= 128, "Unexpected fixed group width");
    double r0 = square_difference(query[0], candidate[0]);
    double r1 = square_difference(query[1], candidate[1]);
    double r2 = square_difference(query[2], candidate[2]);
    double r3 = square_difference(query[3], candidate[3]);
    double r4 = square_difference(query[4], candidate[4]);
    double r5 = square_difference(query[5], candidate[5]);
    double r6 = square_difference(query[6], candidate[6]);
    double r7 = square_difference(query[7], candidate[7]);
    int i = 8;
    for (; i + 7 < Width; i += 8) {
        r0 += square_difference(query[i], candidate[i]);
        r1 += square_difference(query[i + 1], candidate[i + 1]);
        r2 += square_difference(query[i + 2], candidate[i + 2]);
        r3 += square_difference(query[i + 3], candidate[i + 3]);
        r4 += square_difference(query[i + 4], candidate[i + 4]);
        r5 += square_difference(query[i + 5], candidate[i + 5]);
        r6 += square_difference(query[i + 6], candidate[i + 6]);
        r7 += square_difference(query[i + 7], candidate[i + 7]);
    }
    double result = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < Width; ++i) result += square_difference(query[i], candidate[i]);
    return result;
}

inline double shape_distance(const double* query, const double* candidate) noexcept {
    double terms[8];
    for (int i = 0; i < 8; ++i) {
        terms[i] = square_difference(query[i], candidate[i]) * kShapeWeights[i];
    }
    const double sum = ((terms[0] + terms[1]) + (terms[2] + terms[3]))
                     + ((terms[4] + terms[5]) + (terms[6] + terms[7]));
    return std::sqrt(sum / 21.3);
}

inline double mouth_action_distance(const double* query, const double* candidate) noexcept {
    double sum = 0.0;
    for (int i = 0; i < 24; ++i) {
        const int index = kMouthIndexes[i];
        sum += square_difference(query[index], candidate[index]) * kMouthWeights[i];
    }
    return std::sqrt(sum / 40.5);
}

inline double blend_distance(const double* query, const double* candidate) noexcept {
    double sum = 0.0;
    for (int i = 0; i < 51; ++i) {
        sum += square_difference(query[i + 3], candidate[i + 3]) * kBlendWeights[i];
    }
    return std::sqrt(sum / 48.65);
}

inline bool pointers_present(const MFPreparedFaces* value) noexcept {
    if (value == nullptr || value->count < 0) return false;
    if (value->count == 0) return true;
    return value->features && value->contour && value->mouth && value->left_eye
        && value->right_eye && value->brows && value->nose && value->expression
        && value->mouth_shape && value->blinks;
}

}  // namespace

extern "C" {

// No descriptor or candidate-subset allocation occurs in this function.
// If indexes is null, output_count must equal the complete candidate count.
// Otherwise each output row follows the supplied index, including duplicates.
// components, when non-null, has layout [23, output_count] in the order recorded
// by native_scorer.COMPONENT_NAMES. Output scores are always required for N > 0.
// Status: 0 success, 1 invalid contract, 2 invalid candidate index,
//         3 nonfinite final score. All input descriptor memory is read-only.
int mf_strict_score(
    const MFPreparedFaces* query,
    std::int64_t query_index,
    const MFPreparedFaces* candidates,
    const std::int64_t* indexes,
    std::int64_t output_count,
    int compensate_roll,
    double* scores,
    double* components
) noexcept {
    if (!pointers_present(query) || !pointers_present(candidates)
        || query_index < 0 || query_index >= query->count || output_count < 0
        || (compensate_roll != 0 && compensate_roll != 1)
        || (indexes == nullptr && output_count != candidates->count)
        || (output_count > 0 && scores == nullptr)) return 1;

    const double* qf = query->features + query_index * 55;
    const double* qe = query->expression + query_index * 8;
    const double* qb = query->blinks + query_index * 2;
    const double target_wink = qb[0] - qb[1];
    const double activity = std::max(0.0, std::min(1.0, (std::abs(target_wink) - .14) / .42));
    const double local_wink_weight = .42 + activity * .58;
    const double final_wink_weight = .12 + activity * .48;

    for (std::int64_t out = 0; out < output_count; ++out) {
        const std::int64_t ci = indexes ? indexes[out] : out;
        if (ci < 0 || ci >= candidates->count) return 2;
        const double* cf = candidates->features + ci * 55;
        const double* ce = candidates->expression + ci * 8;
        const double* cb = candidates->blinks + ci * 2;

        const double contour = std::sqrt(grouped_sum<72>(query->contour + query_index * 72, candidates->contour + ci * 72) / 36.0);
        const double mouth = std::sqrt(grouped_sum<62>(query->mouth + query_index * 62, candidates->mouth + ci * 62) / 31.0);
        const double left_eye = std::sqrt(grouped_sum<32>(query->left_eye + query_index * 32, candidates->left_eye + ci * 32) / 16.0);
        const double right_eye = std::sqrt(grouped_sum<32>(query->right_eye + query_index * 32, candidates->right_eye + ci * 32) / 16.0);
        const double brows = std::sqrt(grouped_sum<40>(query->brows + query_index * 40, candidates->brows + ci * 40) / 20.0);
        const double nose = std::sqrt(grouped_sum<36>(query->nose + query_index * 36, candidates->nose + ci * 36) / 18.0);
        const double eyes = std::max(left_eye, right_eye);

        double mouth_descriptor_sum = 0.0;
        for (int i = 0; i < 4; ++i) {
            mouth_descriptor_sum += square_difference(qe[i], ce[i]) * kExpressionWeights[i];
        }
        const double mouth_descriptor = std::sqrt(mouth_descriptor_sum / 7.5);
        const double eye_descriptor = std::sqrt((square_difference(qe[4], ce[4]) * 1.5
                                               + square_difference(qe[5], ce[5]) * 1.5) / 3.0);
        const double brow_descriptor = std::sqrt((square_difference(qe[6], ce[6])
                                                + square_difference(qe[7], ce[7])) / 2.0);
        const double mouth_action = mouth_action_distance(qf, cf);
        const double mouth_geometry = shape_distance(query->mouth_shape + query_index * 8, candidates->mouth_shape + ci * 8);
        const double mouth_shape = mouth_geometry * .62 + mouth_action * .38;
        const double blendshape = blend_distance(qf, cf);

        const double blink = std::max(std::abs(qb[0] - cb[0]), std::abs(qb[1] - cb[1]));
        const double wink = std::abs(target_wink - (cb[0] - cb[1]));
        const double yaw = (qf[0] - cf[0]) * 90.0;
        const double pitch = (qf[1] - cf[1]) * 90.0;
        const double roll = (qf[2] - cf[2]) * 90.0;
        const double pose_degrees = std::hypot(std::hypot(yaw, pitch), compensate_roll ? 0.0 : roll * .35);
        const double pose_unit = pose_degrees / 90.0;
        const double pitch_unit = std::abs(pitch) / 90.0;
        const double shape_gate = contour * .62 + nose * .2 + pose_unit * .08 + pitch_unit * .1;
        const double worst_local = std::max({
            mouth * 1.15, left_eye * 1.6, right_eye * 1.6, brows * 1.2,
            mouth_descriptor * .48, mouth_shape * .95, eye_descriptor * .52,
            brow_descriptor * .4, blendshape * .16, blink * .42,
            wink * local_wink_weight,
        });
        const double strict_total = shape_gate * .23 + worst_local * .54
            + (mouth + eyes + brows) / 3.0 * .08 + pitch_unit * .15 + wink * final_wink_weight;
        if (!std::isfinite(strict_total)) return 3;
        scores[out] = strict_total;

        if (components) {
            const double values[kComponentCount] = {
                strict_total, strict_total, contour, mouth, left_eye, right_eye,
                eyes, brows, nose, mouth_descriptor, mouth_action, mouth_shape,
                eye_descriptor, brow_descriptor, blendshape, wink, blink,
                shape_gate, worst_local, pose_degrees, yaw, pitch, roll,
            };
            for (int field = 0; field < kComponentCount; ++field) {
                components[field * output_count + out] = values[field];
            }
        }
    }
    return 0;
}

}  // extern "C"
