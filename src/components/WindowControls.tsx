import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Control = "min" | "max" | "close";

/**
 * Windows-style minimize / maximize-restore / close buttons. Hover is
 * state-driven, not CSS `:hover`, so it can be force-cleared when WebView2
 * drops the `mouseleave` of a fast flick out across the window edge.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [hovered, setHovered] = useState<Control | null>(null);
  const hoveredRef = useRef<Control | null>(null);
  hoveredRef.current = hovered;
  const hoverGen = useRef(0);

  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let stop: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => void appWindow.isMaximized().then(setMaximized))
      .then((unlisten) => { stop = unlisten; });
    return () => stop?.();
  }, []);

  /**
   * While (and only while) a button is hovered, ask the OS where the cursor
   * really is and clear the hover once it is outside the client rect. A tick may
   * only clear the hover generation that was current when it started, so a stale
   * "outside" verdict cannot kill a fresh re-entry.
   */
  useEffect(() => {
    if (!isTauri()) return;
    const clear = () => setHovered(null);
    window.addEventListener("blur", clear);
    let checking = false;
    const id = window.setInterval(async () => {
      if (!hoveredRef.current || checking) return;
      checking = true;
      const gen = hoverGen.current;
      try {
        const appWindow = getCurrentWindow();
        const [position, size, [cx, cy]] = await Promise.all([
          appWindow.innerPosition(),
          appWindow.innerSize(),
          invoke<[number, number]>("cursor_position")
        ]);
        const outside = cx < position.x
          || cy < position.y
          || cx >= position.x + size.width
          || cy >= position.y + size.height;
        if (gen === hoverGen.current && outside) clear();
      } catch {
        /* A failed poll defers the check to the next tick. */
      } finally {
        checking = false;
      }
    }, 100);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const enter = (control: Control) => {
    hoverGen.current++;
    setHovered(control);
  };
  const appWindow = isTauri() ? getCurrentWindow() : null;
  /** onMouseMove restores hover after a dropped mouseleave, when re-entry fires no mouseenter. */
  const hoverProps = (control: Control) => ({
    onMouseEnter: () => enter(control),
    onMouseMove: () => enter(control),
    onMouseLeave: () => setHovered(null)
  });

  return (
    <div className="window-controls">
      <button
        aria-label="Minimize"
        className={hovered === "min" ? "hovered" : ""}
        onClick={() => appWindow?.minimize()}
        {...hoverProps("min")}
      >
        <svg viewBox="0 0 10 10"><path d="M.5 5h9" /></svg>
      </button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        className={hovered === "max" ? "hovered" : ""}
        onClick={() => appWindow?.toggleMaximize()}
        {...hoverProps("max")}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" /><path d="M2.5 2.5v-2h7v7h-2" /></svg>
        ) : (
          <svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" /></svg>
        )}
      </button>
      <button
        aria-label="Close"
        className={`window-close ${hovered === "close" ? "hovered" : ""}`}
        onClick={() => appWindow?.close()}
        {...hoverProps("close")}
      >
        <svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>
      </button>
    </div>
  );
}
