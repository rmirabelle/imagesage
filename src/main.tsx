import { invoke } from "@tauri-apps/api/core";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/**
 * Block the WebView's default context menu everywhere except text fields,
 * which keep it for cut, copy, and paste. Custom menus still open because
 * React handlers run before this document listener.
 */
document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  event.preventDefault();
});

/** Sends an error to the app's error output (the dev log); outside the app it does nothing. */
const logError = (message: string) => {
  invoke("log_frontend_error", { message }).catch(() => { /* Not running in the app. */ });
};
window.addEventListener("error", (event) => logError(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (event) => logError(`Unhandled rejection: ${event.reason?.stack ?? String(event.reason)}`));

/** True after the crash screen took over; a later good hot update then reloads the window. */
let crashed = false;

/**
 * Dev only: the window reports each hot update it applied, each failed one,
 * and its console errors and warnings to the dev log (as "[client] ..."), so
 * an edit can be confirmed as live. A failed hot update prints only to the
 * window's console otherwise, where nobody sees it.
 */
if (import.meta.hot) {
  const hot = import.meta.hot;
  const report = (message: string) => hot.send("imagesage:log", { message });
  hot.on("vite:afterUpdate", (payload) => {
    report(`hot update applied: ${payload.updates.map((update) => update.path).join(", ")}`);
    if (crashed) {
      report("reloading after the crash screen");
      window.location.reload();
    }
  });
  hot.on("vite:error", (payload) => report(`hot update error: ${payload.err.message}`));
  hot.on("vite:ws:disconnect", () => report("hot update connection lost"));
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      report(`console.${level}: ${args.map((arg) => arg instanceof Error ? arg.stack ?? arg.message : String(arg)).join(" ")}`);
    };
  }
  report("window loaded");
}

/** A crash shows its error and a Reload button instead of a blank window, and goes to the dev log. */
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    crashed = true;
    logError(`${error.stack ?? error.message}\nComponent stack:${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <h1>Image Sage stopped with an error</h1>
        <pre>{this.state.error.stack ?? this.state.error.message}</pre>
        <button className="button primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(<CrashScreen><App /></CrashScreen>);
