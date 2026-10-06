import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DownloadSimple } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { WindowControls } from "./WindowControls";

interface Props {
  updateAvailable: boolean;
  onAbout: () => void;
  /** Shown at the right, just before the window controls. */
  end?: ReactNode;
}

/**
 * The window's title bar: the app name, the update button when an update is
 * ready, `end` (the OpenAI status), and the window controls. The menus sit in
 * the menu bar under it.
 */
export function TitleBar({ updateAvailable, onAbout, end }: Props) {
  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
    >
      <div className="brand" data-tauri-drag-region>
        <img src="/icon.ico" alt="" />
        <span>Image Sage</span>
      </div>
      {updateAvailable && (
        <button className="titlebar-update-button" onClick={onAbout} data-help="A new Image Sage version is available">
          <DownloadSimple size={14} weight="bold" /> Update available
        </button>
      )}
      <div className="titlebar-spacer" data-tauri-drag-region />
      {end && <div className="titlebar-end">{end}</div>}
      <WindowControls />
    </header>
  );
}
