// Plain-English narration for browser-agent tool calls — port of andro-UI's
// `narration.ts` two-tier approach: a deterministic, dependency-free sentence
// is available immediately (never blocks the UI on a network call), then
// optionally upgraded to a Groq-generated one when a Groq API key is
// configured (Settings → API Keys) — same BYOK key the canvas chat's Groq
// provider already uses (`getSecret(byokId("groq"))`, `src/lib/chat.ts`).

import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { getSecret, byokId } from "../secrets";
import { getToolLabel } from "../chatModels";
import { argsPreview, resultSummary } from "../chatTools";
import type { ToolCallPart } from "../../types/chat";

const GROQ_NARRATION_MODEL = "llama-3.1-8b-instant";

/** Deterministic, always-available sentence — no network call. */
export function fallbackNarration(part: ToolCallPart): string {
  const label = getToolLabel(part.toolName, part.status === "running");
  const target = argsPreview(part.toolName, part.args);
  const base = target ? `${label}: ${target}` : label;
  if (part.status !== "complete" || part.result == null) return base;
  const summary = resultSummary(part.result);
  return summary ? `${base} — ${summary}` : base;
}

/** Fingerprint of the fields that actually change a narration's wording —
 * status transitions and a result arriving are the only things worth
 * re-narrating for; re-running on every poll tick for unchanged calls would
 * just burn API calls for an identical sentence. */
function narrationKey(part: ToolCallPart): string {
  return `${part.id}:${part.status}:${part.result != null ? "1" : "0"}`;
}

let cachedKey: string | null = null;

async function resolveGroqApiKey(): Promise<string | null> {
  if (cachedKey !== null) return cachedKey || null;
  const key = await getSecret(byokId("groq"));
  cachedKey = key || "";
  return key || null;
}

/** Upgrades a batch of tool calls to Groq-generated one-sentence
 * explanations. Deliberately best-effort: any failure (no key configured,
 * network error, malformed response) just means callers keep using
 * `fallbackNarration` — this never throws. */
export async function narrateWithGroq(
  parts: ToolCallPart[],
): Promise<Record<string, string> | null> {
  const apiKey = await resolveGroqApiKey();
  if (!apiKey || parts.length === 0) return null;

  const lines = parts.map((p, i) => {
    const label = getToolLabel(p.toolName);
    const target = argsPreview(p.toolName, p.args);
    const outcome = p.status === "complete" ? resultSummary(p.result) : "(in progress)";
    return `${i + 1}. tool=${label} target=${target || "(none)"} status=${p.status} outcome=${outcome}`;
  });

  try {
    const groq = createGroq({ apiKey });
    const { text } = await generateText({
      model: groq(GROQ_NARRATION_MODEL),
      prompt:
        "You narrate what a coding agent's browser session is doing, one short plain-English " +
        "sentence per numbered action below, present tense, no jargon, no preamble. " +
        "Reply with exactly one line per action, in order, numbered to match input " +
        "(e.g. \"1. Reading the project's package.json\").\n\n" +
        lines.join("\n"),
    });

    const narrated: Record<string, string> = {};
    const outLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of outLines) {
      const m = line.match(/^(\d+)\.\s*(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      const part = parts[idx];
      if (part) narrated[part.id] = m[2].trim();
    }
    return Object.keys(narrated).length > 0 ? narrated : null;
  } catch {
    return null;
  }
}

export { narrationKey };
