import { Sparkles } from "lucide-react";
import type { BrowserMessageEvent } from "../../lib/browserAgent/types";
import { Markdown } from "../Markdown";

// Render Markdown without enabling raw HTML from the browser response.
export function AssistantReplyBubble({ message }: { message: BrowserMessageEvent }) {
  const empty = message.text.trim().length === 0;
  return (
    <div className="browser-agent-turn browser-agent-turn--assistant">
      <span className="browser-agent-turn-icon"><Sparkles size={13} /></span>
      <div className="browser-agent-turn-body">
        <span className="browser-agent-turn-speaker">ChatGPT</span>
        <div className="browser-agent-bubble browser-agent-bubble--assistant">
          {empty && message.streaming ? (
            <span className="browser-agent-typing">ChatGPT is replying…</span>
          ) : (
            <Markdown className="browser-agent-reply">{message.text}</Markdown>
          )}
        </div>
      </div>
    </div>
  );
}
