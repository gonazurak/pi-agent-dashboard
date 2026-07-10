import { describe, expect, it } from "vitest";
import { applyCodexFast56, supportsCodexFast56 } from "../codex-fast-56.js";

describe("Codex Fast GPT-5.6 bridge", () => {
  it("recognizes only the Codex GPT-5.6 family", () => {
    expect(supportsCodexFast56({ provider: "openai-codex", id: "gpt-5.6-sol" })).toBe(true);
    expect(supportsCodexFast56({ provider: "openai-codex", id: "gpt-5.6-terra" })).toBe(true);
    expect(supportsCodexFast56({ provider: "openai-codex", id: "gpt-5.6-luna" })).toBe(true);
    expect(supportsCodexFast56({ provider: "openai", id: "gpt-5.6-sol" })).toBe(false);
    expect(supportsCodexFast56({ provider: "openai-codex", id: "gpt-5.5" })).toBe(false);
  });

  it("adds priority only when Fast is enabled for an eligible model", () => {
    const payload = { input: "hello" };
    expect(applyCodexFast56(payload, { provider: "openai-codex", id: "gpt-5.6-sol" }, true)).toEqual({
      input: "hello",
      service_tier: "priority",
    });
    expect(applyCodexFast56(payload, { provider: "openai-codex", id: "gpt-5.6-sol" }, false)).toBe(payload);
    expect(applyCodexFast56(payload, { provider: "openai", id: "gpt-5.6-sol" }, true)).toBe(payload);
  });
});
