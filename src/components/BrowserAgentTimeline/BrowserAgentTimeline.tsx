import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ToolCallCard } from "../ChatPane/ToolCallCard";
import { buildTimeline } from "../../lib/browserAgent/timeline";
import { fallbackNarration, narrateWithGroq, narrationKey } from "../../lib/browserAgent/narration";
import type { BrowserMessageEvent, BrowserToolCallEvent } from "../../lib/browserAgent/types";
import type { ToolCallPart } from "../../types/chat";
import { UserPromptBubble } from "./UserPromptBubble";
import { AssistantReplyBubble } from "./AssistantReplyBubble";

/** Narration sentence per tool-call id — starts with the deterministic
 * fallback (instant, no network) and upgrades to a Groq-generated one when a
 * key is configured. Debounced so a burst of poll ticks while a tool call is
 * "running" doesn't fire an API call per tick — only once its narration-
 * relevant fields (status/result presence) actually settle. */
function useNarration(toolCalls: ToolCallPart[]) {
  const [narrated, setNarrated] = useState<Record<string, string>>({});
  const narratedKeys = useRef<Record<string, string>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pending = toolCalls.filter((p) => narratedKeys.current[p.id] !== narrationKey(p));
    if (pending.length === 0) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        const result = await narrateWithGroq(pending);
        if (!result) return;
        for (const p of pending) narratedKeys.current[p.id] = narrationKey(p);
        setNarrated((prev) => ({ ...prev, ...result }));
      })();
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCalls.map((p) => narrationKey(p)).join(",")]);

  return (part: ToolCallPart) => narrated[part.id] ?? fallbackNarration(part);
}

export function BrowserAgentTimeline({
  toolCalls,
  messages,
}: {
  toolCalls: BrowserToolCallEvent[];
  messages: BrowserMessageEvent[];
}) {
  const entries = buildTimeline(toolCalls, messages);
  const narrate = useNarration(toolCalls);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const hasEntries = entries.length > 0;

  useLayoutEffect(() => {
    if (!hasEntries) followLatest.current = true;
    const viewport = scrollRef.current;
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  });

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // Also follow delayed layout changes (images, narration, expanded output).
    const observer = new ResizeObserver(() => {
      if (followLatest.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [hasEntries]);

  if (!hasEntries) {
    return (
      <div className="browser-agent-timeline-empty">
        Send a prompt to start the conversation.
      </div>
    );
  }

  return (
    <div
      className="browser-agent-timeline"
      ref={scrollRef}
      onScroll={(event) => {
        if (event.target !== event.currentTarget) return;
        const viewport = event.currentTarget;
        followLatest.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
      }}
    >
      <div className="browser-agent-timeline-content" ref={contentRef}>
        {entries.map((entry) =>
          entry.kind === "tool" ? (
            <div className="browser-agent-tool-entry" key={`tool:${entry.part.id}`}>
              <div className="browser-agent-narration">{narrate(entry.part)}</div>
              <ToolCallCard part={entry.part} liveOutput />
            </div>
          ) : entry.message.role === "user" ? (
            <UserPromptBubble key={`message:${entry.message.id}`} message={entry.message} />
          ) : (
            <AssistantReplyBubble key={`message:${entry.message.id}`} message={entry.message} />
          ),
        )}
      </div>
    </div>
  );
}
