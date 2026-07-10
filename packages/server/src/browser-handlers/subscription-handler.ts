/**
 * Subscription message handlers: subscribe, unsubscribe.
 */
import type { WebSocket } from "ws";
import type { ServerToBrowserMessage, BrowserToServerMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { BrowserHandlerContext } from "./handler-context.js";
import { extractStatsFromEvents } from "../event-status-extraction.js";
import { pluginIntentCache } from "../plugin-intent-cache.js";
import type { StoredEvent } from "../memory-event-store.js";

const REPLAY_BATCH_SIZE = 50;
/** Max events to replay per session subscription (0 = unlimited). */
function readMaxReplayEvents(): number {
  const raw = process.env.PI_DASHBOARD_MAX_REPLAY_EVENTS;
  if (!raw) return 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}
const MAX_REPLAY_EVENTS = readMaxReplayEvents();
/** Max buffered bytes before pausing replay sends (1MB) */
const BACKPRESSURE_THRESHOLD = 1_024 * 1_024;
const CHAT_REPLAY_ANCHOR_EVENTS = new Set([
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
]);

function limitReplayEvents(events: StoredEvent[]): StoredEvent[] {
  if (MAX_REPLAY_EVENTS > 0 && events.length > MAX_REPLAY_EVENTS) {
    return events.slice(events.length - MAX_REPLAY_EVENTS);
  }
  return events;
}

function hasChatReplayAnchor(events: StoredEvent[]): boolean {
  return events.some((entry) => CHAT_REPLAY_ANCHOR_EVENTS.has(entry.event.eventType));
}

function shouldUsePersistedReplayFallback(replayEvents: StoredEvent[]): boolean {
  return replayEvents.length > 0 && !hasChatReplayAnchor(replayEvents);
}

function toStoredReplay(events: Array<{ eventType: string; timestamp: number; data: Record<string, unknown> }>): StoredEvent[] {
  return events.map((event, index) => ({ seq: index + 1, event }));
}

function sendEventContinuations(
  ws: WebSocket,
  sessionId: string,
  stored: StoredEvent[],
  sendTo: (ws: WebSocket, msg: ServerToBrowserMessage) => void,
): void {
  for (const entry of stored) {
    if (ws.readyState !== ws.OPEN) return;
    sendTo(ws, {
      type: "event",
      sessionId,
      seq: entry.seq,
      event: entry.event,
    });
  }
}

/**
 * Send stored events to a WebSocket in batches with backpressure handling.
 * Yields between batches to let the event loop flush data and avoid OOM.
 */
/**
 * Send stored events to a WebSocket in batches with backpressure handling.
 * Returns the highest seq sent, or 0 if no events were sent.
 */
async function sendEventBatches(
  ws: WebSocket,
  sessionId: string,
  stored: StoredEvent[],
  sendTo: (ws: WebSocket, msg: ServerToBrowserMessage) => void,
): Promise<number> {
  for (let i = 0; i < stored.length; i += REPLAY_BATCH_SIZE) {
    if (ws.readyState !== ws.OPEN) return 0;
    const batch = stored.slice(i, i + REPLAY_BATCH_SIZE);
    sendTo(ws, {
      type: "event_replay",
      sessionId,
      events: batch.map((e) => ({ seq: e.seq, event: e.event })),
      isLast: i + REPLAY_BATCH_SIZE >= stored.length,
    });
    // Yield to event loop between batches to allow GC and buffer flushing
    if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < BACKPRESSURE_THRESHOLD) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        setTimeout(check, 10);
      });
    } else {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  return stored.length > 0 ? stored[stored.length - 1].seq : 0;
}

/**
 * Replay extension-declared UI state to a single browser. Sends:
 *
 *   1. one `ui_modules_list` (when modules exist)                  — Phase 1
 *   2. one `ui_data_list` per cached `(event, items)` entry         — Phase 1
 *   3. one `ext_ui_decorator` per cached `Session.uiDecorators` entry — Phase 2
 *
 * Replay decorator messages NEVER carry `removed: true` — only live entries
 * are replayed; deleted entries are already absent from the cache.
 *
 * Called immediately after every `replayPendingUiRequests` site so the full
 * replay ordering is:
 *
 *   asset_register batch → events → pending UI requests → ui_modules_list → ui_data_list → ext_ui_decorator
 *
 * Exported so unit tests can drive it without standing up a full subscribe
 * pipeline. See changes: add-extension-ui-modal, add-extension-ui-decorations.
 */
export function replayUiState(
  ws: WebSocket,
  sessionId: string,
  ctx: Pick<BrowserHandlerContext, "sessionManager" | "sendTo">,
): void {
  const { sessionManager, sendTo } = ctx;
  const session = sessionManager.get(sessionId);
  if (!session) return;
  if (session.uiModules && session.uiModules.length > 0) {
    sendTo(ws, { type: "ui_modules_list", sessionId, modules: session.uiModules } as any);
  }
  if (session.uiDataMap) {
    for (const [event, items] of Object.entries(session.uiDataMap)) {
      sendTo(ws, { type: "ui_data_list", sessionId, event, items } as any);
    }
  }
  if (session.uiDecorators) {
    for (const descriptor of Object.values(session.uiDecorators)) {
      sendTo(ws, { type: "ext_ui_decorator", sessionId, descriptor } as any);
    }
  }

  // Replay cached plugin intents for this session (per-session AND global).
  // See change: adopt-server-driven-intent-rendering.
  for (const entry of pluginIntentCache.getForSession(sessionId)) {
    sendTo(ws, {
      type: "plugin_intents",
      pluginId: entry.pluginId,
      sessionId: entry.sessionId,
      slot: entry.slot,
      intent: entry.intent,
    } as any);
  }
  // Also replay global (sessionId === null) intents.
  for (const entry of pluginIntentCache.getForSession(null)) {
    sendTo(ws, {
      type: "plugin_intents",
      pluginId: entry.pluginId,
      sessionId: null,
      slot: entry.slot,
      intent: entry.intent,
    } as any);
  }
}

/**
 * Replay the per-session image asset registry to a single browser. Sends one
 * `asset_register` message per `(hash, { data, mimeType })` entry in
 * `Session.assets`. Called BEFORE `sendEventBatches` so any `pi-asset:<hash>`
 * tokens in replayed `message_update` / `message_end` events have their
 * referent in the client's session map by the time they're reduced.
 *
 * See change: chat-markdown-local-images-and-math.
 */
export function replaySessionAssets(
  ws: WebSocket,
  sessionId: string,
  ctx: Pick<BrowserHandlerContext, "sessionManager" | "sendTo">,
): void {
  const { sessionManager, sendTo } = ctx;
  const session = sessionManager.get(sessionId);
  if (!session?.assets) return;
  for (const [hash, asset] of Object.entries(session.assets)) {
    if (!asset || typeof asset.data !== "string" || typeof asset.mimeType !== "string") continue;
    sendTo(ws, {
      type: "asset_register",
      sessionId,
      hash,
      mimeType: asset.mimeType,
      data: asset.data,
    } as any);
  }
}

export function handleSubscribe(
  msg: Extract<BrowserToServerMessage, { type: "subscribe" }>,
  subs: Set<string>,
  ctx: BrowserHandlerContext,
): void {
  const { ws, sessionManager, eventStore, directoryService, piGateway, sendTo, broadcast, getSubscribers, replayPendingUiRequests, markReplaying, clearReplaying, viewMessageStore } = ctx;
  subs.add(msg.sessionId);

  // Send the current view-messages snapshot before any event replay so the
  // client can merge view rows into the rendered chat.
  // See change: render-file-previews.
  if (viewMessageStore) {
    sendTo(ws, {
      type: "view_messages_update",
      sessionId: msg.sessionId,
      viewMessages: viewMessageStore.get(msg.sessionId),
    });
  }

  // Request metadata from the extension so commands/flows/models/roles arrive
  // while the browser is actually subscribed (responses use sendToSubscribers).
  piGateway.sendToSession(msg.sessionId, { type: "request_commands", sessionId: msg.sessionId });
  piGateway.sendToSession(msg.sessionId, { type: "request_models", sessionId: msg.sessionId });
  // See change: replace-hardcoded-provider-lists.
  piGateway.sendToSession(msg.sessionId, { type: "request_providers", sessionId: msg.sessionId });
  piGateway.sendToSession(msg.sessionId, { type: "request_roles", sessionId: msg.sessionId });

  // Explicit history expansion: reload a larger persisted window without
  // increasing the default cold-open replay. The client requests this only
  // after the user clicks "Load earlier messages".
  const requestedReplayLimit = Math.min(10_000, Math.max(MAX_REPLAY_EVENTS, msg.replayLimit ?? 0));
  const historySession = sessionManager.get(msg.sessionId);
  if (msg.replayLimit && requestedReplayLimit > MAX_REPLAY_EVENTS && directoryService && historySession?.sessionFile) {
    sendTo(ws, { type: "session_state_reset", sessionId: msg.sessionId });
    sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: false });
    const closeOpenToolCalls = historySession.status === "ended";
    markReplaying(ws, msg.sessionId);
    directoryService.loadSessionEvents(
      msg.sessionId,
      historySession.sessionFile,
      historySession.contextWindow,
      requestedReplayLimit,
      closeOpenToolCalls,
    ).then(async (result) => {
      if (!result.success) {
        clearReplaying(ws, msg.sessionId, eventStore.getMaxSeq(msg.sessionId));
        sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
        return;
      }
      replaySessionAssets(ws, msg.sessionId, ctx);
      await sendEventBatches(ws, msg.sessionId, toStoredReplay(result.events), sendTo);
      clearReplaying(ws, msg.sessionId, eventStore.getMaxSeq(msg.sessionId));
      replayPendingUiRequests(ws, msg.sessionId);
      replayUiState(ws, msg.sessionId, ctx);
    }).catch(() => {
      clearReplaying(ws, msg.sessionId, eventStore.getMaxSeq(msg.sessionId));
      sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
    });
    return;
  }

  if (eventStore.hasEvents(msg.sessionId)) {
    const lastSeq = msg.lastSeq ?? 0;
    const maxSeq = eventStore.getMaxSeq(msg.sessionId);
    const session = sessionManager.get(msg.sessionId);

    const replayEvents = async (events: StoredEvent[], catchUpAfterSeq?: number) => {
      replaySessionAssets(ws, msg.sessionId, ctx);
      if (events.length > 0) {
        markReplaying(ws, msg.sessionId);
      }
      const lastSent = await sendEventBatches(ws, msg.sessionId, events, sendTo);
      if (events.length > 0) {
        clearReplaying(ws, msg.sessionId, catchUpAfterSeq ?? lastSent);
      }
      replayPendingUiRequests(ws, msg.sessionId);
      replayUiState(ws, msg.sessionId, ctx);
    };

    const replayPersistedBaseThenLiveTail = async (persisted: StoredEvent[], liveTail: StoredEvent[]) => {
      replaySessionAssets(ws, msg.sessionId, ctx);
      markReplaying(ws, msg.sessionId);
      await sendEventBatches(ws, msg.sessionId, persisted, sendTo);
      sendEventContinuations(ws, msg.sessionId, liveTail, sendTo);
      clearReplaying(ws, msg.sessionId, maxSeq);
      replayPendingUiRequests(ws, msg.sessionId);
      replayUiState(ws, msg.sessionId, ctx);
    };

    const replayWithPersistedFallback = (events: StoredEvent[], allowFallback: boolean): boolean => {
      if (!allowFallback || !directoryService || !session?.sessionFile || !shouldUsePersistedReplayFallback(events)) {
        return false;
      }
      const closeOpenToolCalls = session.status === "ended";
      directoryService.loadSessionEvents(msg.sessionId, session.sessionFile, session.contextWindow, MAX_REPLAY_EVENTS, closeOpenToolCalls)
        .then(async (result) => {
          if (result.success && result.events.length > 0) {
            await replayPersistedBaseThenLiveTail(toStoredReplay(result.events), events);
            return;
          }
          await replayEvents(events);
        })
        .catch(async () => {
          await replayEvents(events);
        });
      return true;
    };

    // Stale lastSeq: client has higher seq than server (e.g. server restarted)
    if (lastSeq > 0 && lastSeq > maxSeq) {
      sendTo(ws, { type: "session_state_reset", sessionId: msg.sessionId });
      // Full replay from seq 1
      const allEvents = eventStore.getEvents(msg.sessionId, 1);
      const events = limitReplayEvents(allEvents);
      if (!replayWithPersistedFallback(events, true)) {
        replayEvents(events);
      }
    } else {
      const allEvents = eventStore.getEvents(msg.sessionId, lastSeq + 1);
      const events = limitReplayEvents(allEvents);
      // Suppress live events during paginated replay to prevent out-of-order
      // delivery. The client's `event_replay` reset rule (firstSeq <= maxSeq)
      // misfires if a live `event` arrives between batches and bumps maxSeq
      // past the next batch's firstSeq — wiping state to a fresh build of
      // only the last batch. Suppression+catch-up via clearReplaying preserves
      // ordering for both cold (lastSeq=0) and warm (lastSeq>0) subscribes.
      // See change: fix-cold-subscribe-replay-interleave.
      if (!replayWithPersistedFallback(events, lastSeq === 0)) {
        replayEvents(events);
      }
    }
  } else if (directoryService) {
    const session = sessionManager.get(msg.sessionId);
    if (session?.sessionFile) {
      sendTo(ws, {
        type: "event_replay",
        sessionId: msg.sessionId,
        events: [],
        isLast: false,
      });
      const closeOpenToolCalls = session.status === "ended";
      directoryService.loadSessionEvents(msg.sessionId, session.sessionFile, session.contextWindow, MAX_REPLAY_EVENTS, closeOpenToolCalls).then(async (result) => {
        if (result.success) {
          for (const evt of result.events) {
            eventStore.insertEvent(msg.sessionId, evt);
          }
          const statsUpdates = extractStatsFromEvents(result.events);
          const metaUpdates: Record<string, unknown> = { dataUnavailable: false, ...statsUpdates };
          sessionManager.update(msg.sessionId, metaUpdates);
          broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: metaUpdates });
          const stored = limitReplayEvents(eventStore.getEvents(msg.sessionId, 1));
          const subscribers = getSubscribers(msg.sessionId);
          for (const sub of subscribers) {
            // Asset registry first — see change: chat-markdown-local-images-and-math.
            replaySessionAssets(sub, msg.sessionId, ctx);
            await sendEventBatches(sub, msg.sessionId, stored, sendTo);
            replayPendingUiRequests(sub, msg.sessionId);
            replayUiState(sub, msg.sessionId, ctx);
          }
        } else if (result.error === "cancelled") {
          // The load was cancelled because the subscriber left before it
          // resolved. Do NOT mark the session dataUnavailable or replay to a
          // gone ws — the session is fine, the work was just abandoned.
          // See change: offload-session-events-load-to-worker.
        } else {
          sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
          sessionManager.update(msg.sessionId, { dataUnavailable: true });
          broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { dataUnavailable: true } });
        }
      }).catch(() => {
        sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
        sessionManager.update(msg.sessionId, { dataUnavailable: true });
        broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { dataUnavailable: true } });
      });
    } else {
      sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
      if (session) {
        sessionManager.update(msg.sessionId, { dataUnavailable: true });
        broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { dataUnavailable: true } });
      }
    }
  } else {
    sendTo(ws, { type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
  }
}
