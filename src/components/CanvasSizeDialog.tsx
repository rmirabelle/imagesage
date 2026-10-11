import { ArrowsOut, Check, CornersOut, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

/** Where the old image sits in the new canvas: a column and a row, each 0 (left/top), 1 (middle) or 2 (right/bottom). */
export type Anchor = { column: 0 | 1 | 2; row: 0 | 1 | 2 };

/** The new canvas size, and where the old image's top left lands in it. */
export interface CanvasChange {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** The canvas change for a new size with the old image placed at `anchor`. */
export function placeAt(oldWidth: number, oldHeight: number, width: number, height: number, anchor: Anchor): CanvasChange {
  const offset = (old: number, size: number, at: 0 | 1 | 2) => at === 0 ? 0 : at === 1 ? Math.round((size - old) / 2) : size - old;
  return { width, height, x: offset(oldWidth, width, anchor.column), y: offset(oldHeight, height, anchor.row) };
}

/** The largest side an image may have. */
const MAX_SIDE = 8192;

interface Props {
  /** "canvas" adds or trims space around the image; "image" resizes the image itself. */
  mode: "canvas" | "image";
  width: number;
  height: number;
  onCancel: () => void;
  onApply: (change: CanvasChange) => void;
}

/** A 3 × 3 grid of buttons: where the old image sits in the new canvas. */
function AnchorGrid({ anchor, onChange }: { anchor: Anchor; onChange: (anchor: Anchor) => void }) {
  return (
    <div className="anchor-grid" role="radiogroup" aria-label="Anchor">
      {([0, 1, 2] as const).flatMap((row) => ([0, 1, 2] as const).map((column) => {
        const active = anchor.row === row && anchor.column === column;
        return (
          <button
            key={`${row}-${column}`}
            role="radio"
            aria-checked={active}
            aria-label={`${["Top", "Middle", "Bottom"][row]} ${["left", "center", "right"][column]}`}
            className={active ? "active" : ""}
            onClick={() => onChange({ row, column })}
          />
        );
      }))}
    </div>
  );
}

/**
 * Canvas Size: a new width and height, with an anchor that says where the
 * image stays; the new space is transparent. Image Size: a new width and
 * height for the image itself, resampled, with its proportions kept unless
 * Keep proportions is off.
 */
export function CanvasSizeDialog({ mode, width, height, onCancel, onApply }: Props) {
  const [anchor, setAnchor] = useState<Anchor>({ column: 1, row: 1 });
  const [widthText, setWidthText] = useState(String(width));
  const [heightText, setHeightText] = useState(String(height));
  const [keepProportions, setKeepProportions] = useState(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  /** With Keep proportions (Image Size), a new width sets the height to match, and the other way round. */
  const keeps = mode === "image" && keepProportions;
  const changeWidth = (text: string) => {
    setWidthText(text);
    const value = Number(text);
    if (keeps && value > 0) setHeightText(String(Math.max(1, Math.round((value * height) / width))));
  };
  const changeHeight = (text: string) => {
    setHeightText(text);
    const value = Number(text);
    if (keeps && value > 0) setWidthText(String(Math.max(1, Math.round((value * width) / height))));
  };

  const newWidth = Math.round(Number(widthText));
  const newHeight = Math.round(Number(heightText));
  const error = !Number.isFinite(newWidth) || !Number.isFinite(newHeight) || newWidth < 1 || newHeight < 1
    ? "Width and height must be whole numbers of at least 1."
    : Math.max(newWidth, newHeight) > MAX_SIDE
      ? `The longest side can be at most ${MAX_SIDE} px.`
      : null;
  const unchanged = newWidth === width && newHeight === height;
  const apply = () => {
    if (error || unchanged) return;
    onApply(mode === "image" ? { width: newWidth, height: newHeight, x: 0, y: 0 } : placeAt(width, height, newWidth, newHeight, anchor));
  };
  const percent = (value: number, old: number) => Number.isFinite(value) && value > 0 ? ` (${Math.round((value / old) * 100)}%)` : "";

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div className="save-dialog canvas-size-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-size-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon">{mode === "image" ? <ArrowsOut size={22} weight="duotone" /> : <CornersOut size={22} weight="duotone" />}</div>
          <div>
            <h2 id="canvas-size-title">{mode === "image" ? "Image Size" : "Canvas Size"}</h2>
            <p>
              {mode === "image"
                ? "Resizes the whole image: every layer and mask. A larger image is lightly sharpened."
                : "Adds space around the image, or trims it. The new space is transparent."}
            </p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="save-dialog-body">
          <section className="save-dialog-section new-image-form">
            <div className="form-row">
              <label className="form-row-label" htmlFor="canvas-width">Width</label>
              <span className="canvas-size-field">
                <span className="save-size-input-shell">
                  <input id="canvas-width" type="number" min={1} max={MAX_SIDE} autoFocus value={widthText} onChange={(event) => changeWidth(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") apply(); }} />
                  <b>px</b>
                </span>
                <span className="canvas-size-result">{percent(newWidth, width)}</span>
              </span>
            </div>
            <div className="form-row">
              <label className="form-row-label" htmlFor="canvas-height">Height</label>
              <span className="canvas-size-field">
                <span className="save-size-input-shell">
                  <input id="canvas-height" type="number" min={1} max={MAX_SIDE} value={heightText} onChange={(event) => changeHeight(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") apply(); }} />
                  <b>px</b>
                </span>
                <span className="canvas-size-result">{percent(newHeight, height)}</span>
              </span>
            </div>
            {mode === "image" ? (
              <div className="form-row">
                <span className="form-row-label" />
                <label className="settings-toggle">
                  <input type="checkbox" checked={keepProportions} onChange={(event) => setKeepProportions(event.target.checked)} />
                  Keep proportions
                </label>
              </div>
            ) : (
              <div className="form-row form-row-top">
                <span className="form-row-label">Anchor</span>
                <div className="anchor-row">
                  <AnchorGrid anchor={anchor} onChange={setAnchor} />
                  <span className="anchor-note">The image stays at the picked place; the space is added on the other sides.</span>
                </div>
              </div>
            )}
            <div className="form-row">
              <span className="form-row-label">Now</span>
              <span className="canvas-size-result">{width} × {height} px</span>
            </div>
            {error && <div className="settings-check error"><WarningCircle size={16} weight="fill" /><span>{error}</span></div>}
          </section>
        </div>
        <footer className="save-dialog-actions">
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button className="button primary" disabled={Boolean(error) || unchanged} onClick={apply}>
            <Check size={16} weight="bold" /> OK
          </button>
        </footer>
      </div>
    </div>
  );
}
