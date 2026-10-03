import { runtimeIdentity } from "../../runtime-identity";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(runtimeIdentity, { headers: { "cache-control": "no-store" } });
}
