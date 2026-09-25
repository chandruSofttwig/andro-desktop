import ReactDOM from "react-dom/client";
import "./fonts.css";
import App from "./App";
import { ThemeProvider } from "./themes/ThemeContext";
import { loadAppState } from "./lib/runtimeState";
import { refreshAgentRegistry } from "./lib/agentRegistry";
import { loadSessions } from "./store/sessions";
import { loadProjects } from "./store/openProjects";
import { loadRecents } from "./store/recents";
import { loadTabs } from "./store/tabs";
import { terminalRendererPolicy } from "./lib/terminalRenderer";

// StrictMode intentionally removed — it double-invokes effects which causes
// PTY sessions to spawn twice on mount.
(async () => {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // Hydrate every in-memory mirror from SQLite before the first render. All of
  // these are independent, so one failing (a corrupt row, or — in a web
  // preview without the real Tauri backend — every invoke() rejecting)
  // must not stop the rest from loading or block the app from ever
  // rendering. `Promise.all` would reject as a whole on the first failure;
  // `allSettled` lets each stand on its own.
  const results = await Promise.allSettled([
    loadAppState(), loadSessions(), loadProjects(), loadRecents(), loadTabs(),
    terminalRendererPolicy.initialize(),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[startup] loader failed:", r.reason);
  }
  // AGENT_CONFIGS was built at module load with an empty runtime state; now
  // that customAgents is hydrated, rebuild so user-added entries appear.
  refreshAgentRegistry();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
})();
