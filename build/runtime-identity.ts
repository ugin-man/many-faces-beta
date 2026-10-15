import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
export function buildIdentity() {
  const hash = createHash("sha256");
  const visit = (root: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) visit(path);
      else { hash.update(path); hash.update("\0"); hash.update(readFileSync(path)); }
    }
  };
  for (const dir of ["app", "worker", "build"]) visit(dir);
  for (const path of ["vite.config.ts", "package-lock.json", ".openai/hosting.json"]) { hash.update(path); hash.update(readFileSync(path)); }
  let revision = "source-snapshot";
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Source packages may have no .git directory. */ }
  return { build: hash.digest("hex").slice(0, 16), revision };
}
