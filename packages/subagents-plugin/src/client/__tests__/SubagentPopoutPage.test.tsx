/**
 * SubagentPopoutPage — loading / not-found / found tests.
 *
 * See change: add-subagent-inspector.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  UiPrimitiveProvider,
  createUiPrimitiveRegistry,
  registerUiPrimitive,
} from "@blackbelt-technology/dashboard-plugin-runtime";
import { UI_PRIMITIVE_KEYS } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/ui-primitives.js";
import { SubagentPopoutPage } from "../SubagentPopoutPage.js";
import type { SessionStateLike } from "../SubagentDetailView.js";
import type { SubagentState } from "../types.js";

const MockMarkdown: React.FC<{ content: string }> = ({ content }) => <div data-testid="md">{content}</div>;

function sessionWithAgent(agentId: string, sub: Partial<SubagentState> = {}): SessionStateLike {
  return {
    subagents: new Map([[agentId, {
      id: agentId,
      type: "Explore",
      description: "",
      status: "running",
      ...sub,
    } as SubagentState]]),
  };
}

function emptySession(): SessionStateLike {
  return { subagents: new Map() };
}

function renderWithPrimitives(ui: React.ReactElement): string {
  const registry = createUiPrimitiveRegistry();
  registerUiPrimitive(registry, UI_PRIMITIVE_KEYS.markdownContent, MockMarkdown);
  return renderToStaticMarkup(
    <UiPrimitiveProvider value={registry}>{ui}</UiPrimitiveProvider>,
  );
}

describe("SubagentPopoutPage", () => {
  it("shows loading state before subscription resolves", () => {
    const html = renderWithPrimitives(
      <SubagentPopoutPage
        sessionId="sess_42"
        agentId="abc123"
        session={undefined}
        subscriptionResolved={false}
      />,
    );
    expect(html).toContain("Loading parent session");
  });

  it("shows 'parent session not found' when subscription resolves with no session", () => {
    const html = renderWithPrimitives(
      <SubagentPopoutPage
        sessionId="sess_42"
        agentId="abc123"
        session={undefined}
        subscriptionResolved={true}
      />,
    );
    expect(html).toContain("Parent session not found");
  });

  it("shows 'subagent not found' when parent session exists but agent does not", () => {
    const html = renderWithPrimitives(
      <SubagentPopoutPage
        sessionId="sess_42"
        agentId="missing"
        session={emptySession()}
        subscriptionResolved={true}
      />,
    );
    expect(html).toContain("Subagent not found");
  });

  it("renders a chat-style popout when subagent is found", () => {
    const session = sessionWithAgent("abc123", {
      displayName: "explorer",
      description: "Inspect the project",
      status: "running",
      activity: "reading",
      toolUses: 2,
      entries: [{ kind: "text", text: "Looking up files", ts: 1 }],
    });
    const html = renderWithPrimitives(
      <SubagentPopoutPage
        sessionId="sess_42"
        agentId="abc123"
        session={session}
        subscriptionResolved={true}
        parentLabel="/home/me/project"
      />,
    );
    expect(html).toContain("/home/me/project");
    expect(html).toContain("data-testid=\"subagent-chat-view\"");
    expect(html).toContain("Inspect the project");
    expect(html).toContain("Looking up files");
  });

  it("renders agentMdPath in the chrome header when present", () => {
    const session = sessionWithAgent("abc123", {
      displayName: "code-reviewer",
      status: "completed",
      agentMdPath: "/home/u/.pi/agent/agents/CodeReviewer.md",
      result: "LGTM",
    });
    const html = renderWithPrimitives(
      <SubagentPopoutPage
        sessionId="sess_42"
        agentId="abc123"
        session={session}
        subscriptionResolved={true}
        parentLabel="/home/me/project"
      />,
    );
    // The path renders as monospace text under the displayName.
    expect(html).toContain("/home/u/.pi/agent/agents/CodeReviewer.md");
  });
});
