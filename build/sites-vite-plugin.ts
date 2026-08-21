import type { Plugin } from "vite";

/**
 * Repository-safe fallback for the Sites runtime plugin.
 *
 * The hosted editing environment may provide additional behavior at runtime,
 * but CI and fresh clones still need a resolvable module. Keeping this plugin
 * intentionally minimal makes builds deterministic without changing the app.
 */
export function sites(): Plugin {
  return {
    name: "sites-vite-plugin-placeholder",
  };
}
