// Binding names come from .openai/hosting.json. Optional because local preview
// intentionally runs without persistent storage. Runtime types are official.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ASSETS?: Fetcher;
    CATALOG_UPLOAD_KEY?: string;
  }
}
