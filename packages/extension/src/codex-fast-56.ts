import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_FAST_56_MODELS = new Set([
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
]);

export function supportsCodexFast56(model: { provider?: string; id?: string } | undefined): boolean {
  return Boolean(model && CODEX_FAST_56_MODELS.has(`${model.provider}/${model.id}`));
}

function isFastEnabled(): boolean {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    return settings?.["pi-codex-fast"]?.enabled === true;
  } catch {
    return false;
  }
}

export function applyCodexFast56(
  payload: unknown,
  model: { provider?: string; id?: string } | undefined,
  enabled: boolean,
): unknown {
  if (!enabled || !supportsCodexFast56(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...(payload as Record<string, unknown>), service_tier: "priority" };
}

export function activateCodexFast56(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event: any, ctx: any) => {
    return applyCodexFast56(event?.payload, ctx?.model, isFastEnabled());
  });
}
