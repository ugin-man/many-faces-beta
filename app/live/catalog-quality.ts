export type CatalogQualityExclusion = { id: string; reason: "sunglasses" | "face_mask" | "yaw_mismatch" | "expression_occluded" | string };
export type CatalogQualityOverlay = { schemaVersion: 1; baseCatalogId?: string; excluded: CatalogQualityExclusion[] };
export function shouldReadLegacyQualityOverlay(admission: unknown): boolean {
  if (admission === undefined) return true;
  if (!admission || typeof admission !== "object") throw new Error("CATALOG_ADMISSION_INVALID: カタログの品質確認情報を読み込めません。");
  const value = admission as Record<string, unknown>;
  const hashes = ["policySha256", "receiptSha256", "recordsSha256", "attributeModelSha256", "faceModelSha256"];
  if (value.schemaVersion !== 2 || value.status !== "complete" || value.selectedCount !== 70000 || value.runtimeExclusionOverlayRequired !== false || typeof value.policyId !== "string" || !value.policyId || hashes.some(key => typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key] as string))) {
    throw new Error("CATALOG_ADMISSION_INVALID: カタログの品質確認情報が一致しません。");
  }
  // Every physical entry in this catalog was admitted before selection. The
  // old optional runtime exclusion list must not silently shrink the new core.
  return false;
}
export function parseCatalogQualityOverlay(payload: unknown) {
  if (!payload || typeof payload !== "object") return new Map<string, CatalogQualityExclusion>();
  const data = payload as Partial<CatalogQualityOverlay>;
  if (data.schemaVersion !== 1 || !Array.isArray(data.excluded)) return new Map<string, CatalogQualityExclusion>();
  const result = new Map<string, CatalogQualityExclusion>();
  for (const item of data.excluded) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.reason !== "string") continue;
    result.set(item.id, { id: item.id, reason: item.reason });
  }
  return result;
}
export function qualityAllows(id: string, exclusions: ReadonlyMap<string, CatalogQualityExclusion>) { return !exclusions.has(id); }
