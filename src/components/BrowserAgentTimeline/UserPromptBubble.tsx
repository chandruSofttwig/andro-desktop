import type { BrowserMessageEvent } from "../../lib/browserAgent/types";

export function UserPromptBubble({ message }: { message: BrowserMessageEvent }) {
  return (
    <div className="browser-agent-turn browser-agent-turn--user">
      <div className="browser-agent-bubble browser-agent-bubble--user">{message.text}</div>
    </div>
  );
}
