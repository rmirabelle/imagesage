import { Check, ImageSquare, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { validateGenerateSize } from "../editor/region";

interface Props {
  onCancel: () => void;
  /** Opens a blank document of this size in a new tab. */
  onCreate: (width: number, height: number) => void;
}

const PRESETS = [
  { label: "Square", size: "1024x1024" },
  { label: "Landscape", size: "1536x1024" },
  { label: "Portrait", size: "1024x1536" },
  { label: "Large square", size: "2048x2048" },
  { label: "Wide 16:9", size: "2560x1440" },
  { label: "Tall 9:16", size: "1440x2560" }
];
const SIZE_KEY = "imagesage.new-image-size";
/** The preview shows only the shape: its longest side is always this many screen pixels. */
const PREVIEW_SIDE = 220;
/** The space for the preview, so the dialog keeps its height for every shape. */
const PREVIEW_AREA_HEIGHT = 240;

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The size of a new blank image: the sizes in a list at the left, a picture of the chosen size at the right. */
export function NewImageDialog({ onCancel, onCreate }: Props) {
  const [size, setSize] = useState(() => readStored(SIZE_KEY) ?? "1536x1024");
  const [customWidth, setCustomWidth] = useState(() => size.split("x")[0]);
  const [customHeight, setCustomHeight] = useState(() => size.split("x")[1]);
  const custom = !PRESETS.some((preset) => preset.size === size);
  const effectiveSize = custom ? `${customWidth}x${customHeight}` : size;
  const [width, height] = effectiveSize.split("x").map(Number);
  const sizeError = validateGenerateSize(width, height);
  /** A size that is not a number shows no picture. */
  const previewScale = width > 0 && height > 0 ? PREVIEW_SIDE / Math.max(width, height) : 0;
  const pick = (value: string) => setSize(value === "custom" ? `${customWidth}x${customHeight}-custom` : value);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const create = () => {
    if (sizeError) return;
    try {
      localStorage.setItem(SIZE_KEY, effectiveSize);
    } catch {
      /* Remembering the last size is a convenience only. */
    }
    onCreate(width, height);
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div
        className="save-dialog new-image-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-image-title"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) create(); }}
      >
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon"><ImageSquare size={22} weight="duotone" /></div>
          <div>
            <h2 id="new-image-title">New Image</h2>
            <p>Opens a blank image in a new tab. Start with a prompt, or add a layer and paint.</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>

        <div className="settings-layout new-image-layout">
          <nav className="settings-nav" aria-label="Sizes">
            {PRESETS.map((preset) => (
              <button key={preset.size} className={!custom && size === preset.size ? "active" : ""} autoFocus={!custom && size === preset.size} onClick={() => pick(preset.size)}>
                <span>
                  <strong>{preset.label}</strong>
                  <small>{preset.size.replace("x", " × ")}</small>
                </span>
              </button>
            ))}
            <button className={custom ? "active" : ""} autoFocus={custom} onClick={() => pick("custom")}>
              <span>
                <strong>Custom</strong>
                <small>Any width and height</small>
              </span>
            </button>
          </nav>
          <div className="settings-pane new-image-pane">
            {custom && (
              <div className="form-row-size">
                <span className="save-size-input-shell">
                  <input type="number" step={16} aria-label="Width" value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} />
                  <b>px</b>
                </span>
                <span aria-hidden="true">×</span>
                <span className="save-size-input-shell">
                  <input type="number" step={16} aria-label="Height" value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} />
                  <b>px</b>
                </span>
              </div>
            )}
            <div className="new-image-preview" style={{ height: PREVIEW_AREA_HEIGHT }} aria-hidden="true">
              {previewScale > 0 && (
                <div className="new-image-preview-shape" style={{ width: Math.max(2, width * previewScale), height: Math.max(2, height * previewScale) }} />
              )}
            </div>
            <p className="new-image-preview-size">{width > 0 && height > 0 ? `${width} × ${height} px` : ""}</p>
            {sizeError && <div className="settings-check error"><WarningCircle size={16} weight="fill" /><span>{sizeError}</span></div>}
          </div>
        </div>

        <footer className="save-dialog-actions">
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button className="button primary" disabled={Boolean(sizeError)} onClick={create}>
            <Check size={16} weight="bold" /> OK
          </button>
        </footer>
      </div>
    </div>
  );
}
