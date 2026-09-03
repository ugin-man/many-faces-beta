#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { mergeFaceCatalog } from "./merge-face-catalog-lib.mjs";

function args(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const base = values.get("--base");
  const supplement = values.get("--supplement");
  if (!base || !supplement) {
    throw new Error("Usage: merge-face-catalog.mjs --base <catalog> --supplement <catalog> [--batch-id <id>]");
  }
  return {
    base: path.resolve(base),
    supplement: path.resolve(supplement),
    batchId: (values.get("--batch-id") ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14))
      .replace(/[^a-zA-Z0-9_-]/g, "_"),
    catalogId: values.get("--catalog-id") ?? "",
  };
}

mergeFaceCatalog(args(process.argv)).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
