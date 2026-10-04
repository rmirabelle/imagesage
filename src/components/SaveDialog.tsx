import { FileJpg, FilePng, FloppyDisk, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

export type SaveFormat = "png" | "jpeg";

export interface SaveSettings {
  format: SaveFormat;
  maxWidth: string;
  maxHeight: string;
}

interface Props {
  settings: SaveSettings;
  sourceWidth: number;
  sourceHeight: number;
  onCancel: () => void;
  onSave: (settings: SaveSettings) => void;
}

const digitsOnly = (value: string) => value.replace(/[^0-9]/g, "");

export function SaveDialog({ settings, sourceWidth, sourceHeight, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const output = useMemo(() => {
    const maxWidth = Math.max(0, Math.floor(Number(draft.maxWidth) || 0));
    const maxHeight = Math.max(0, Math.floor(Number(draft.maxHeight) || 0));
    const scale = Math.min(
      1,
      maxWidth > 0 ? maxWidth / sourceWidth : 1,
      maxHeight > 0 ? maxHeight / sourceHeight : 1
    );
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
      scaled: scale < 1
    };
  }, [draft.maxHeight, draft.maxWidth, sourceHeight, sourceWidth]);

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div
        className="save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-image-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon"><FloppyDisk size={22} weight="fill" /></div>
          <div>
            <h2 id="export-image-title">Export Image</h2>
            <p>Choose the file format and optional maximum dimensions.</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close save dialog" data-help="Close">
            <X size={18} />
          </button>
        </header>

        <div className="save-dialog-body">
          <section className="save-dialog-section">
            <div className="save-format-options" role="radiogroup" aria-label="File format">
              <button
                className={`save-format-option ${draft.format === "png" ? "selected" : ""}`}
                role="radio"
                aria-checked={draft.format === "png"}
                onClick={() => setDraft((current) => ({ ...current, format: "png" }))}
              >
                <FilePng size={25} weight="duotone" />
                <span><strong>PNG</strong><small>Lossless · transparency</small></span>
                <i aria-hidden="true" />
              </button>
              <button
                className={`save-format-option ${draft.format === "jpeg" ? "selected" : ""}`}
                role="radio"
                aria-checked={draft.format === "jpeg"}
                onClick={() => setDraft((current) => ({ ...current, format: "jpeg" }))}
              >
                <FileJpg size={25} weight="duotone" />
                <span><strong>JPEG</strong><small>Smaller file · 92% quality</small></span>
                <i aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="save-dialog-section">
            <div className="save-size-fields">
              <label>
                <span>Maximum width</span>
                <div className="save-size-input-shell">
                  <input
                    autoFocus
                    type="text"
                    inputMode="numeric"
                    placeholder="Unconstrained"
                    value={draft.maxWidth}
                    onChange={(event) => setDraft((current) => ({ ...current, maxWidth: digitsOnly(event.target.value) }))}
                    aria-label="Maximum export width"
                  />
                  <b>px</b>
                </div>
              </label>
              <label>
                <span>Maximum height</span>
                <div className="save-size-input-shell">
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Unconstrained"
                    value={draft.maxHeight}
                    onChange={(event) => setDraft((current) => ({ ...current, maxHeight: digitsOnly(event.target.value) }))}
                    aria-label="Maximum export height"
                  />
                  <b>px</b>
                </div>
              </label>
            </div>
            <div className="save-output-summary" aria-live="polite">
              <span>Output size</span>
              <strong>{output.width} × {output.height} px</strong>
              <small>{output.scaled ? `Downscaled proportionally from ${sourceWidth} × ${sourceHeight}` : "Original image size"}</small>
            </div>
          </section>
        </div>

        <footer className="save-dialog-actions">
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button className="button primary" onClick={() => onSave(draft)}>
            <FloppyDisk size={17} weight="bold" /> Choose Location
          </button>
        </footer>
      </div>
    </div>
  );
}
