import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DownloadSimple, Info, Keyboard } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { WindowControls } from "./WindowControls";

interface Props {
  updateAvailable: boolean;
  onAbout: () => void;
  onShortcuts: () => void;
}

export function TitleBar({ updateAvailable, onAbout, onShortcuts }: Props) {
  const [openMenu, setOpenMenu] = useState<"help" | null>(null);
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const openAbout = () => {
    setOpenMenu(null);
    onAbout();
  };

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
    >
      <div className="brand" data-tauri-drag-region>
        <img src="/icon.ico" alt="" />
        <span>ImageSage</span>
      </div>
      <nav ref={menuRef} className="titlebar-menu" aria-label="Application menu">
        <div className="titlebar-menu-root">
          <button className={openMenu === "help" ? "active" : ""} onClick={() => setOpenMenu((menu) => menu === "help" ? null : "help")}>Help</button>
          {openMenu === "help" && (
            <div className="titlebar-menu-dropdown">
              <button onClick={() => { setOpenMenu(null); onShortcuts(); }}>
                <span><Keyboard size={15} /> Keyboard shortcuts</span>
              </button>
              <button onClick={openAbout}>
                <span><Info size={15} /> About ImageSage</span>
              </button>
            </div>
          )}
        </div>
        {updateAvailable && (
          <button className="titlebar-update-button" onClick={onAbout} data-help="A new ImageSage version is available">
            <DownloadSimple size={14} weight="bold" /> Update available
          </button>
        )}
      </nav>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <WindowControls />
    </header>
  );
}
