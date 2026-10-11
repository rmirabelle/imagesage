import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { hexToHsb, hsbToHex, type Hsb } from "../editor/color";

/** The color wheel's size on screen, in CSS pixels. */
const WHEEL_SIZE = 116;
/** Quick colors above the wheel: white, red and black. A gray-only picker leaves out red. */
const CHIPS = [
  { color: "#ffffff", label: "White" },
  { color: "#ff0000", label: "Red", colored: true },
  { color: "#000000", label: "Black" }
];

interface Props {
  /** The paint color, as "#rrggbb". */
  color: string;
  onChange: (color: string) => void;
  /** The picker is open; while it is open, a click on the image picks a color (unless `pickFromImage` is false). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The swatch's and the panel's name for screen readers. */
  label?: string;
  /** Only grays: the panel has one slider from black to white. */
  grays?: boolean;
  /** False: a click on the image closes the picker, as any click outside it does. */
  pickFromImage?: boolean;
  /** No swatch: the panel opens below the anchor itself (a gradient stop on the image). */
  hideSwatch?: boolean;
  /**
   * The color is transparent. With `onTransparentChange`, the panel starts
   * with a Transparent box; while it is on, no other color setting matters,
   * so the settings are grayed out and the wheel shows a checkerboard.
   */
  transparent?: boolean;
  onTransparentChange?: (transparent: boolean) => void;
  /**
   * The color's opacity, 0 to 100, with an A slider under the others; the
   * swatch shows a see-through color over a checkerboard. `minAlpha` is the
   * lowest value the slider allows.
   */
  alpha?: number;
  onAlphaChange?: (alpha: number) => void;
  minAlpha?: number;
  /** More controls at the bottom of the panel. */
  children?: ReactNode;
}

/** The light checkerboard behind see-through colors. */
const CHECKERS = "repeating-conic-gradient(#ffffff 0% 25%, #cccccc 0% 50%) 0 0 / 8px 8px";
/** "#rrggbb" at `alpha` (0 to 100) as an rgba() color. */
const withAlpha = (hex: string, alpha: number) => {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha / 100})`;
};

/**
 * A number box for one HSB value. While it has focus it keeps the typed text;
 * each valid number changes the color at once, and Enter or a click away ends
 * the edit.
 */
function NumberField({ label, value, max, disabled, onChange }: { label: string; value: number; max: number; disabled?: boolean; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      disabled={disabled}
      inputMode="numeric"
      aria-label={label}
      value={draft ?? String(Math.round(value))}
      onFocus={(event) => {
        setDraft(String(Math.round(value)));
        event.currentTarget.select();
      }}
      onChange={(event) => {
        const text = event.target.value.replace(/[^0-9]/g, "").slice(0, 3);
        setDraft(text);
        if (text) onChange(Math.min(max, Number(text)));
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/**
 * The paint color swatch for the toolbar. A click opens the color picker
 * below it: a color wheel on the left (hue around it, saturation from the
 * middle out, at the current brightness), and on the right the hue,
 * saturation and brightness sliders, the hex code and the eyedropper. With
 * `grays`, the panel has only a gray slider.
 */
export function ColorPicker({ color, onChange, open, onOpenChange: setOpen, label = "Paint color", grays = false, pickFromImage = true, hideSwatch = false, transparent = false, onTransparentChange, alpha, onAlphaChange, minAlpha = 0, children }: Props) {
  const [hsb, setHsb] = useState<Hsb>(() => hexToHsb(color) ?? { h: 0, s: 0, b: 0 });
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLCanvasElement>(null);

  /** A color set from outside (the eyedropper) replaces the HSB values; the picker's own changes keep the hue of grays. */
  useEffect(() => {
    if (hsbToHex(hsb).toLowerCase() === color.toLowerCase()) return;
    const next = hexToHsb(color);
    if (next) setHsb(next);
  }, [color]);

  const change = (next: Hsb) => {
    const value = grays ? { h: 0, s: 0, b: next.b } : next;
    setHsb(value);
    onChange(hsbToHex(value));
  };

  /** The wheel at the current brightness: hues around it, white in the middle. */
  useLayoutEffect(() => {
    const canvas = wheelRef.current;
    if (!open || !canvas || grays) return;
    const ratio = window.devicePixelRatio || 1;
    const size = Math.round(WHEEL_SIZE * ratio);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const context = canvas.getContext("2d")!;
    const center = size / 2;
    context.clearRect(0, 0, size, size);
    context.save();
    context.beginPath();
    context.arc(center, center, center, 0, Math.PI * 2);
    context.clip();
    const hues = context.createConicGradient(-Math.PI / 2, center, center);
    for (let hue = 0; hue <= 360; hue += 30) hues.addColorStop(hue / 360, hsbToHex({ h: hue, s: 100, b: 100 }));
    context.fillStyle = hues;
    context.fillRect(0, 0, size, size);
    const white = context.createRadialGradient(center, center, 0, center, center, center);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = white;
    context.fillRect(0, 0, size, size);
    context.fillStyle = `rgba(0,0,0,${1 - hsb.b / 100})`;
    context.fillRect(0, 0, size, size);
    context.restore();
  }, [hsb.b, open, grays]);

  /** A click outside closes the picker; a click on the image picks a color instead. Esc closes it. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (rootRef.current?.contains(target) || (pickFromImage && target.closest?.(".interaction-layer"))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, setOpen, pickFromImage]);

  const pickOnWheel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
    const s = Math.min(1, Math.hypot(dx, dy) / (rect.width / 2)) * 100;
    /** On a black wheel no color can be seen, so a click there brings the brightness up. */
    change({ h, s, b: hsb.b > 0 ? hsb.b : 100 });
  };

  const angle = ((hsb.h - 90) * Math.PI) / 180;
  const markerRadius = (hsb.s / 100) * (WHEEL_SIZE / 2);
  const hex = hsbToHex(hsb);
  const commitHex = () => {
    if (hexDraft !== null) {
      const next = hexToHsb(hexDraft);
      if (next) change(next);
    }
    setHexDraft(null);
  };

  /** A chip sets its color, fully solid (opacity 100); the picker stays open. */
  const chips = (
    <div className="color-chips" role="group" aria-label="Quick colors">
      {CHIPS.filter((chip) => !(grays && "colored" in chip)).map((chip) => (
        <button
          key={chip.color}
          className="color-chip"
          style={{ background: chip.color }}
          aria-label={chip.label}
          onClick={() => {
            if (transparent) onTransparentChange?.(false);
            onAlphaChange?.(100);
            const next = hexToHsb(chip.color);
            if (next) change(next);
          }}
        />
      ))}
    </div>
  );

  const sliders = grays
    ? [{ key: "b", label: "Gray", max: 100, track: "linear-gradient(to right, #000000, #ffffff)" }] as const
    : [
      { key: "h", label: "H", max: 360, track: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((h) => hsbToHex({ h, s: 100, b: 100 })).join(", ")})` },
      { key: "s", label: "S", max: 100, track: `linear-gradient(to right, ${hsbToHex({ ...hsb, s: 0 })}, ${hsbToHex({ ...hsb, s: 100 })})` },
      { key: "b", label: "B", max: 100, track: `linear-gradient(to right, #000000, ${hsbToHex({ ...hsb, b: 100 })})` }
    ] as const;

  return (
    <div className={`color-picker-anchor ${hideSwatch ? "no-swatch" : ""}`} ref={rootRef}>
      {!hideSwatch && (
        <button
          className={`paint-swatch ${open ? "open" : ""} ${transparent ? "clear" : ""}`}
          style={transparent ? undefined : alpha !== undefined && alpha < 100
            ? { background: `linear-gradient(${withAlpha(color, alpha)}, ${withAlpha(color, alpha)}), ${CHECKERS}` }
            : { background: color }}
          onClick={() => setOpen(!open)}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
        />
      )}
      {open && (
        <div className={`color-picker ${grays ? "grays" : ""} ${transparent ? "transparent" : ""}`} role="dialog" aria-label={label}>
          {/* The wheel's section: the left part of the panel, top to bottom, a little darker, with the wheel in its middle. */}
          {!grays && <div className="color-wheel-section">
            {chips}
            {/* With an opacity, the wheel is as see-through as the color, over a checkerboard. */}
            <div className="color-wheel" style={alpha !== undefined ? { background: CHECKERS, borderRadius: "50%" } : undefined}>
              <canvas
                ref={wheelRef}
                style={{ width: WHEEL_SIZE, height: WHEEL_SIZE, opacity: alpha !== undefined ? alpha / 100 : 1 }}
                onPointerDown={(event) => {
                  if (transparent) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pickOnWheel(event);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) pickOnWheel(event);
                }}
                aria-label="Color wheel"
              />
              {transparent
                ? <span className="color-wheel-clear" aria-hidden="true" />
                : (
                  <span
                    className="color-wheel-marker"
                    style={{ left: WHEEL_SIZE / 2 + Math.cos(angle) * markerRadius, top: WHEEL_SIZE / 2 + Math.sin(angle) * markerRadius, background: hex }}
                    aria-hidden="true"
                  />
                )}
            </div>
          </div>}
          {/* OK fills the bottom-right corner of the panel; the panel's rounded corner is its corner. */}
          <button className="color-ok" onClick={() => setOpen(false)}>OK</button>
          <div className="color-fields">
            {grays && chips}
            {onTransparentChange && (
              <label className="color-check color-transparent">
                <input type="checkbox" checked={transparent} onChange={(event) => onTransparentChange(event.target.checked)} />
                Transparent
              </label>
            )}
            {sliders.map(({ key, label, max, track }) => {
              /** At brightness 0 the color is black whatever its hue and saturation, so those two sliders do nothing. */
              const inert = transparent || (key !== "b" && hsb.b === 0);
              return (
              <div className={`color-field ${inert ? "disabled" : ""}`} key={key}>
                <label htmlFor={`color-${key}`}>{label}</label>
                <input
                  id={`color-${key}`}
                  type="range"
                  min={0}
                  max={max}
                  step={1}
                  value={Math.round(hsb[key])}
                  disabled={inert}
                  style={{ background: track }}
                  onChange={(event) => change({ ...hsb, [key]: Number(event.target.value) })}
                />
                <NumberField label={label === "H" ? "Hue" : label === "S" ? "Saturation" : label === "Gray" ? "Gray" : "Brightness"} value={hsb[key]} max={max} disabled={inert} onChange={(value) => change({ ...hsb, [key]: value })} />
              </div>
              );
            })}
            {/* A: the opacity, from see-through to solid over a checkerboard. It stays usable while Transparent is on, so it can bring the color back. */}
            {alpha !== undefined && onAlphaChange && !grays && (
              <div className="color-field">
                <label htmlFor="color-a">A</label>
                <input
                  id="color-a"
                  type="range"
                  min={minAlpha}
                  max={100}
                  step={1}
                  value={Math.round(alpha)}
                  style={{ background: `linear-gradient(to right, ${withAlpha(color, 0)}, ${withAlpha(color, 100)}), ${CHECKERS}` }}
                  onChange={(event) => onAlphaChange(Number(event.target.value))}
                />
                <NumberField label="Opacity" value={alpha} max={100} onChange={(value) => onAlphaChange(Math.max(minAlpha, value))} />
              </div>
            )}
            {!grays && <div className={`color-field ${transparent ? "disabled" : ""}`}>
              <label htmlFor="color-hex">Hex</label>
              <input
                id="color-hex"
                className="color-hex"
                type="text"
                disabled={transparent}
                spellCheck={false}
                value={hexDraft ?? hex.slice(1).toUpperCase()}
                onFocus={(event) => {
                  setHexDraft(hex.slice(1).toUpperCase());
                  event.currentTarget.select();
                }}
                onChange={(event) => setHexDraft(event.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6))}
                onBlur={commitHex}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span />
            </div>}
            {children && <div className="color-extra">{children}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
