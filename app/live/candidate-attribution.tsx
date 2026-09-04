import { safeHttpLink } from "../public-image-policy";

export type Attribution = {
  creator?: string;
  sourceName?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
};

export function CandidateAttribution({ candidate }: { candidate: Attribution | null }) {
  if (!candidate) return null;
  const source = safeHttpLink(candidate.sourceUrl);
  const license = safeHttpLink(candidate.licenseUrl);
  return (
    <div data-testid="candidate-attribution" style={{ padding: "0 16px 14px", display: "flex", flexWrap: "wrap", gap: "6px 12px", fontSize: 12, overflowWrap: "anywhere" }}>
      <span>{candidate.creator || "作者情報なし"}</span>
      {source ? <a href={source} target="_blank" rel="noopener noreferrer">出典</a> : <span>出典URLなし</span>}
      {license ? <a href={license} target="_blank" rel="noopener noreferrer">{candidate.license || "利用条件"}</a> : <span>{candidate.license || "利用条件未確認"}</span>}
      <span>顔の切り抜き・縮小・WebP変換</span>
    </div>
  );
}
