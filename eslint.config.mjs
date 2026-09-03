import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/live-face-lab.tsx"],
    rules: {
      // Loading the external catalog on mount is an intentional synchronization
      // effect. The async fetch callback owns the resulting state transitions.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Copied verbatim from @mediapipe/tasks-vision for same-origin runtime use.
    "public/mediapipe/**",
  ]),
]);

export default eslintConfig;
