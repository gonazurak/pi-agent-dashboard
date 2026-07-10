import React from "react";
import { UI_PRIMITIVE_KEYS } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/ui-primitives.js";
import { useUiPrimitive, useUiPrimitiveOrNull } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { SubagentState, SubagentTimelineEntry } from "./types.js";

interface SubagentChatViewProps {
  subagent: SubagentState;
  sessionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function toResult(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function UserBubble({ text }: { text: string }) {
  const MarkdownContent = useUiPrimitive(UI_PRIMITIVE_KEYS.markdownContent);
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] bg-blue-500/10 border border-blue-500/20 border-l-2 border-l-blue-400 rounded-xl shadow-md px-4 py-2">
        <MarkdownContent content={text} />
      </div>
    </div>
  );
}

function AssistantBubble({ text, tone = "normal" }: { text: string; tone?: "normal" | "error" }) {
  const MarkdownContent = useUiPrimitive(UI_PRIMITIVE_KEYS.markdownContent);
  const cls = tone === "error"
    ? "bg-red-500/10 border-red-500/25 border-l-red-400 text-red-100"
    : "bg-[var(--bg-tertiary)] border-[var(--border-subtle)] border-l-[var(--border-secondary)]";
  return (
    <div className="flex justify-start">
      <div className={`max-w-[80%] border border-l-2 rounded-xl shadow-md px-4 py-2 ${cls}`}>
        <MarkdownContent content={text} />
      </div>
    </div>
  );
}

function ThinkingChatEntry({ text }: { text: string }) {
  const ThinkingBlockImpl = useUiPrimitiveOrNull(UI_PRIMITIVE_KEYS.thinkingBlock);
  if (ThinkingBlockImpl) {
    return <ThinkingBlockImpl content={text} />;
  }
  return (
    <div className="border-l-2 border-purple-500/30 pl-3 text-sm text-purple-300/80">
      <div className="text-xs uppercase tracking-wide text-purple-300/60 mb-1">Reasoning</div>
      <pre className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{text}</pre>
    </div>
  );
}

function ToolChatEntry({
  entry,
  index,
  sessionId,
}: {
  entry: Extract<SubagentTimelineEntry, { kind: "tool" }>;
  index: number;
  sessionId?: string;
}) {
  const ToolCallStepImpl = useUiPrimitiveOrNull(UI_PRIMITIVE_KEYS.toolCallStep);
  const result = toResult(entry.output);
  if (ToolCallStepImpl) {
    return (
      <ToolCallStepImpl
        toolName={entry.toolName}
        toolCallId={`subagent-${index}`}
        args={asRecord(entry.input)}
        status={entry.isError ? "error" : result !== undefined ? "complete" : "running"}
        result={result}
        sessionId={sessionId}
      />
    );
  }

  return (
    <div className={`border-l-2 pl-3 py-1.5 ${entry.isError ? "border-red-500/50" : "border-blue-500/30"}`}>
      <div className={`text-xs font-mono ${entry.isError ? "text-red-400" : "text-blue-400"}`}>
        {entry.toolName}
      </div>
      {result && (
        <pre className="text-[11px] text-[var(--text-secondary)] mt-1 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words bg-[var(--bg-tertiary)] rounded p-2">
          {result}
        </pre>
      )}
    </div>
  );
}

function renderEntry(entry: SubagentTimelineEntry, index: number, sessionId?: string) {
  switch (entry.kind) {
    case "text":
      return <AssistantBubble key={index} text={entry.text} />;
    case "thinking":
      return <ThinkingChatEntry key={index} text={entry.text} />;
    case "tool":
      return <ToolChatEntry key={index} entry={entry} index={index} sessionId={sessionId} />;
    case "error":
      return <AssistantBubble key={index} text={entry.text} tone="error" />;
    default: {
      const _exhaustive: never = entry;
      void _exhaustive;
      return null;
    }
  }
}

export function SubagentChatView({ subagent, sessionId }: SubagentChatViewProps) {
  const entries = subagent.entries ?? [];
  const prompt = subagent.description.trim();
  const result = subagent.result?.trim();
  const error = subagent.error?.trim();
  const hasVisibleContent = prompt || entries.length > 0 || result || error;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-primary)]" data-testid="subagent-chat-view">
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {prompt && <UserBubble text={prompt} />}
        {entries.map((entry, index) => renderEntry(entry, index, sessionId))}
        {error && <AssistantBubble text={error} tone="error" />}
        {result && <AssistantBubble text={result} />}
        {!hasVisibleContent && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
            No messages yet
          </div>
        )}
      </div>
    </div>
  );
}
