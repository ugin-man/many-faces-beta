export type CatalogQualityExclusion = { id: string; reason: "sunglasses" | "face_mask" | "yaw_mismatch" | "expression_occluded" | string };
export type CatalogQualityOverlay = { schemaVersion: 1; baseCatalogId?: string; excluded: CatalogQualityExclusion[] };
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
