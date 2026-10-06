import { useEffect, useRef, useState, type ReactNode } from "react";

/** One menu item, or a line between groups of items. */
export type MenuItem =
  | { label: string; icon?: ReactNode; shortcut?: string; disabled?: boolean; run: () => void }
  | "separator";

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

/**
 * The window's menu bar, under the title bar, like a standard Windows menu:
 * click a menu to open it; while one is open, pointing at another opens that
 * one. A click outside or Esc closes it, and choosing an item runs it.
 */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const onBlur = () => setOpen(null);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  return (
    <nav ref={barRef} className="menubar" aria-label="Application menu">
      {menus.map((menu) => (
        <div key={menu.id} className="menubar-root">
          <button
            type="button"
            className={open === menu.id ? "active" : ""}
            aria-haspopup="menu"
            aria-expanded={open === menu.id}
            onClick={() => setOpen((current) => current === menu.id ? null : menu.id)}
            onPointerEnter={() => setOpen((current) => current && current !== menu.id ? menu.id : current)}
          >
            {menu.label}
          </button>
          {open === menu.id && (
            <div className="menubar-dropdown" role="menu">
              {menu.items.map((item, index) => item === "separator" ? (
                <div key={`separator-${index}`} className="menubar-divider" role="separator" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(null);
                    item.run();
                  }}
                >
                  <span className="menubar-item-icon">{item.icon}</span>
                  <span className="menubar-item-label">{item.label}</span>
                  {item.shortcut && <small>{item.shortcut}</small>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
