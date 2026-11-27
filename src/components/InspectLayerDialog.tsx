import { X } from "@phosphor-icons/react";
import { Fragment, useEffect, useState } from "react";
import { settingsText, type LayerSettings } from "../editor/recipe";

/**
 * Edit → Inspect Layer: every setting that made one layer, and buttons that
 * copy them as text or as JSON. The values can be selected and copied one by
 * one too. For a local layer, Use These Settings sets up the prompt bar to
 * make the same image again.
 */
export function InspectLayerDialog({ name, settings, onUse, onClose }: { name: string; settings: LayerSettings; onUse: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState<"text" | "json" | "failed" | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copy = async (kind: "text" | "json") => {
    try {
      await navigator.clipboard.writeText(kind === "text" ? settingsText(settings) : JSON.stringify(settings.json, null, 2));
      setCopied(kind);
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="save-dialog inspect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspect-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="inspect-title">Inspect Layer: {name}</h2>
          <button className="save-dialog-close" onClick={onClose} aria-label="Close" data-help="Close (Esc)">
            <X size={18} />
          </button>
        </header>
        <div className="inspect-body">
          <p className="inspect-note">{settings.note}</p>
          {settings.sections.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              <dl>
                {section.rows.map((row, index) => (
                  <Fragment key={`${row.label}-${index}`}>
                    <dt>{row.label}</dt>
                    <dd className={row.wide ? "wide" : undefined}>{row.value}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="save-dialog-actions">
          {copied && <span className="dialog-status-note">{copied === "failed" ? "Could not copy." : copied === "json" ? "JSON copied." : "Text copied."}</span>}
          <button className="button" onClick={() => void copy("text")} data-help="Copy every setting as plain text, one per line">Copy Text</button>
          <button className="button" onClick={() => void copy("json")} data-help="Copy every setting as JSON, for scripts and other programs">Copy JSON</button>
          {settings.recipe && (
            <button className="button" onClick={onUse} data-help="Set up the prompt bar with these settings: the next local image uses them in place of Settings → Local">Use These Settings</button>
          )}
          <button className="button primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
