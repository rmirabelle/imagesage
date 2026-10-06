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

/** A crash shows its error and a Reload button instead of a blank window, and goes to the dev log. */
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
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
