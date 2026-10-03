declare const __MF_BUILD_ID__: string;
declare const __MF_REVISION__: string;
export const runtimeIdentity = {
  version: "verification-recovery-v2",
  build: typeof __MF_BUILD_ID__ === "string" ? __MF_BUILD_ID__ : "unbundled-source",
  revision: typeof __MF_REVISION__ === "string" ? __MF_REVISION__ : "source-snapshot",
};
