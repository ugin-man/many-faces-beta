"use client";
import { useEffect, useState } from "react";
import { runtimeIdentity } from "./runtime-identity";
export default function RuntimeCheck() {
  const [server, setServer] = useState("確認中");
  useEffect(() => {
    const cancellation = new AbortController();
    void fetch("/api/runtime", { cache: "no-store", signal: cancellation.signal }).then(async response => {
      if (!response.ok) throw new Error("配信側が旧版です");
      const value = await response.json() as { build?: string };
      if (!cancellation.signal.aborted) setServer(value.build === runtimeIdentity.build ? `一致 / ${value.build}` : `不一致 / ${value.build ?? "不明"}`);
    }).catch(() => { if (!cancellation.signal.aborted) setServer("確認できません。旧版または配信経路の問題です"); });
    return () => cancellation.abort();
  }, []);
  return <p data-testid="runtime-identity">{runtimeIdentity.version}<br />画面 {runtimeIdentity.build}<br />配信 {server}<br />Git {runtimeIdentity.revision}</p>;
}
