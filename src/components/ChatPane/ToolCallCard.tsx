import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { argsPreview, resultSummary } from "../../lib/chatTools";
import { getToolIcon, getToolLabel } from "../../lib/chatModels";
import type { ToolCallPart } from "../../types/chat";

export function ToolCallCard({ part, liveOutput = false }: { part: ToolCallPart; liveOutput?: boolean }) {
  const [expanded, setExpanded] = useState(liveOutput);
  const preview = argsPreview(part.toolName, part.args);
  const Icon = getToolIcon(part.toolName);
  const label = getToolLabel(part.toolName, part.status === "running");
  const canExpand = part.result != null;
  const result = part.result as { content?: unknown; error?: unknown } | undefined;
  const output = liveOutput && typeof result?.content === "string"
    ? result.content
    : resultSummary(part.result);
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  useEffect(() => {
    const element = outputRef.current;
    if (liveOutput && expanded && element && followOutput.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [liveOutput, expanded, output]);
  const dotState = part.status === "running" ? "running" : "complete";

  return (
    <div className="chat-step">
      <button
        className={`chat-step-trigger${canExpand ? " chat-step-trigger--clickable" : ""}`}
        onClick={() => canExpand && setExpanded(e => !e)}
        disabled={!canExpand}
      >
        <span className={`chat-step-dot chat-step-dot--${dotState}`} />
        <span className="chat-step-icon">
          <Icon size={13} />
        </span>
        <span className="chat-step-name">{label}</span>
        {preview && <span className="chat-step-summary">{preview}</span>}
        {canExpand && (
          <ChevronDown
            size={11}
            className={`chat-step-chevron${expanded ? " chat-step-chevron--open" : ""}`}
          />
        )}
      </button>
      <div className={`chat-step-detail${expanded ? " chat-step-detail--open" : ""}`}>
        <div className="chat-step-detail-overflow">
          <div className="chat-step-detail-inner">
            <pre ref={outputRef} onScroll={(event) => {
              const element = event.currentTarget;
              followOutput.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
            }}>{output}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
