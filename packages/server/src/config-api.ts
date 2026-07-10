/**
 * Config REST API helpers: read, write, redact secrets, runtime reload.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, type DashboardConfig, type AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { refreshModelRegistry } from "./model-proxy/registry-singleton.js";
import { setWindowsGitSourceSetting } from "@blackbelt-technology/pi-dashboard-shared/platform/git-source.js";

const REDACTED = "***";
const CODEX_FAST_AGENT_SETTINGS_KEY = "pi-codex-fast";

/**
 * Return the current config with secrets redacted.
 */
function getConfigPaths() {
  const dir = path.join(os.homedir(), ".pi", "dashboard");
  return { dir, file: path.join(dir, "config.json") };
}

export function readConfigRedacted(): DashboardConfig {
  const config = loadConfig();
  if (!hasDashboardCodexFastConfig()) {
    config.codexFast = readCodexFastAgentSettings(config.codexFast);
  }
  if (config.auth) {
    config.auth = redactAuthSecrets(config.auth);
  }
  return config;
}

function getAgentSettingsPath() {
  const dir = path.join(os.homedir(), ".pi", "agent");
  return { dir, file: path.join(dir, "settings.json") };
}

function readJsonFile(file: string): Record<string, any> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasDashboardCodexFastConfig(): boolean {
  const { file } = getConfigPaths();
  const raw = readJsonFile(file);
  return raw.codexFast !== undefined;
}

function normalizeCodexFastConfig(raw: any): { enabled: boolean } {
  return {
    enabled: !!(raw && typeof raw === "object" && raw.enabled === true),
  };
}

function readCodexFastAgentSettings(fallback: { enabled: boolean }): { enabled: boolean } {
  const { file } = getAgentSettingsPath();
  const settings = readJsonFile(file);
  const raw = settings[CODEX_FAST_AGENT_SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return fallback;
  return normalizeCodexFastConfig(raw);
}

function syncCodexFastAgentSettings(raw: any): void {
  const next = normalizeCodexFastConfig(raw);
  const { dir, file } = getAgentSettingsPath();
  const settings = readJsonFile(file);
  const existing =
    settings[CODEX_FAST_AGENT_SETTINGS_KEY] &&
    typeof settings[CODEX_FAST_AGENT_SETTINGS_KEY] === "object" &&
    !Array.isArray(settings[CODEX_FAST_AGENT_SETTINGS_KEY])
      ? settings[CODEX_FAST_AGENT_SETTINGS_KEY]
      : {};
  settings[CODEX_FAST_AGENT_SETTINGS_KEY] = { ...existing, enabled: next.enabled };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

function redactAuthSecrets(auth: AuthConfig): AuthConfig {
  const redacted: AuthConfig = {
    ...auth,
    secret: auth.secret ? REDACTED : "",
    providers: {},
  };
  for (const [key, provider] of Object.entries(auth.providers)) {
    redacted.providers[key] = {
      ...provider,
      clientSecret: REDACTED,
    };
  }
  return redacted;
}

/**
 * Fields that require a server restart to take effect.
 */
const RESTART_FIELDS = new Set(["port", "piPort"]);

export interface WriteConfigResult {
  success: boolean;
  restartRequired: boolean;
  error?: string;
}

/**
 * Merge partial config into existing, preserving redacted secrets, write to disk.
 * Returns whether a restart is needed.
 */
export function writeConfigPartial(partial: Record<string, any>): WriteConfigResult {
  const { dir, file } = getConfigPaths();
  try {
    // Read raw file to preserve unknown fields
    let existing: Record<string, any> = {};
    try {
      const raw = fs.readFileSync(file, "utf-8");
      existing = JSON.parse(raw);
    } catch { /* start fresh */ }

    // Check if restart-requiring fields changed
    let restartRequired = false;
    for (const field of RESTART_FIELDS) {
      if (field in partial && partial[field] !== existing[field]) {
        restartRequired = true;
      }
    }

    // Deep merge auth section, preserving redacted secrets
    if (partial.auth) {
      const existingAuth = existing.auth || {};
      const mergedAuth: any = { ...existingAuth };

      // Preserve secret if redacted
      if (partial.auth.secret === REDACTED || !partial.auth.secret) {
        mergedAuth.secret = existingAuth.secret;
      } else {
        mergedAuth.secret = partial.auth.secret;
      }

      // Merge providers, preserving redacted clientSecrets
      if (partial.auth.providers) {
        mergedAuth.providers = { ...existingAuth.providers };
        for (const [key, provider] of Object.entries(partial.auth.providers) as [string, any][]) {
          const existingProvider = existingAuth.providers?.[key] || {};
          mergedAuth.providers[key] = { ...existingProvider, ...provider };
          if (provider.clientSecret === REDACTED) {
            mergedAuth.providers[key].clientSecret = existingProvider.clientSecret || "";
          }
        }
      }

      if (partial.auth.allowedUsers !== undefined) {
        mergedAuth.allowedUsers = partial.auth.allowedUsers;
      }

      // fix-trusted-networks-no-oauth: propagate bypassHosts / bypassUrls
      // from the incoming partial. Without these, the UI's Trusted Networks
      // save path silently dropped every entry on disk. `!== undefined`
      // (not truthiness) lets an empty array clear all entries.
      if (partial.auth.bypassHosts !== undefined) {
        mergedAuth.bypassHosts = partial.auth.bypassHosts;
      }
      if (partial.auth.bypassUrls !== undefined) {
        mergedAuth.bypassUrls = partial.auth.bypassUrls;
      }

      partial.auth = mergedAuth;
    }

    // Merge tunnel sub-object (deep-merge nested watchdog)
    if (partial.tunnel) {
      const existingTunnel = existing.tunnel ?? {};
      const mergedWatchdog = partial.tunnel.watchdog
        ? { ...(existingTunnel.watchdog ?? {}), ...partial.tunnel.watchdog }
        : existingTunnel.watchdog;
      partial.tunnel = {
        ...existingTunnel,
        ...partial.tunnel,
        ...(mergedWatchdog ? { watchdog: mergedWatchdog } : {}),
      };
    }

    // Merge memoryLimits sub-object
    if (partial.memoryLimits) {
      partial.memoryLimits = { ...existing.memoryLimits, ...partial.memoryLimits };
      restartRequired = true;
    }

    // Merge openspec sub-object (no restart required — live-reconfigured)
    if (partial.openspec) {
      partial.openspec = { ...existing.openspec, ...partial.openspec };
    }

    const shouldSyncCodexFast = Object.prototype.hasOwnProperty.call(partial, "codexFast");
    if (shouldSyncCodexFast && partial.codexFast && typeof partial.codexFast === "object") {
      partial.codexFast = { ...existing.codexFast, ...partial.codexFast };
    } else if (shouldSyncCodexFast) {
      partial.codexFast = { enabled: false };
    }

    const merged = { ...existing, ...partial };

    // Remove computed fields that shouldn't be persisted
    delete merged.resolvedTrustedNetworks;

    // Write
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");

    // Eager-refresh model proxy registry (config may affect proxy settings).
    refreshModelRegistry().catch(() => {});

    if (shouldSyncCodexFast) {
      syncCodexFastAgentSettings(merged.codexFast);
    }

    // windowsGitSource change takes effect for newly spawned children
    // (existing children keep their PATH). Update the cached setting +
    // invalidate; no server restart required. See change:
    // embed-git-bash-on-windows.
    if (partial.windowsGitSource === "auto" || partial.windowsGitSource === "host" || partial.windowsGitSource === "bundled") {
      setWindowsGitSourceSetting(partial.windowsGitSource);
    }

    return { success: true, restartRequired };
  } catch (err: any) {
    return { success: false, restartRequired: false, error: err.message };
  }
}
