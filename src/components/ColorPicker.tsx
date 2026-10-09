import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { hexToHsb, hsbToHex, type Hsb } from "../editor/color";

/** The color wheel's size on screen, in CSS pixels. */
const WHEEL_SIZE = 116;

interface Props {
  /** The paint color, as "#rrggbb". */
  color: string;
  onChange: (color: string) => void;
  /** The picker is open; while it is open, a click on the image picks a color. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A number box for one HSB value. While it has focus it keeps the typed text;
 * each valid number changes the color at once, and Enter or a click away ends
 * the edit.
 */
function NumberField({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
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
 * saturation and brightness sliders, the hex code and the eyedropper.
 */
export function ColorPicker({ color, onChange, open, onOpenChange: setOpen }: Props) {
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
    setHsb(next);
    onChange(hsbToHex(next));
  };

  /** The wheel at the current brightness: hues around it, white in the middle. */
  useLayoutEffect(() => {
    const canvas = wheelRef.current;
    if (!open || !canvas) return;
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
  }, [hsb.b, open]);

  /** A click outside closes the picker; a click on the image picks a color instead. Esc closes it. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (rootRef.current?.contains(target) || target.closest?.(".interaction-layer")) return;
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
  }, [open, setOpen]);

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

  const sliders = [
    { key: "h", label: "H", max: 360, track: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((h) => hsbToHex({ h, s: 100, b: 100 })).join(", ")})` },
    { key: "s", label: "S", max: 100, track: `linear-gradient(to right, ${hsbToHex({ ...hsb, s: 0 })}, ${hsbToHex({ ...hsb, s: 100 })})` },
    { key: "b", label: "B", max: 100, track: `linear-gradient(to right, #000000, ${hsbToHex({ ...hsb, b: 100 })})` }
  ] as const;

  return (
    <div className="color-picker-anchor" ref={rootRef}>
      <button
        className={`paint-swatch ${open ? "open" : ""}`}
        style={{ background: color }}
        onClick={() => setOpen(!open)}
        aria-label="Paint color"
        aria-haspopup="dialog"
        aria-expanded={open}
      />
      {open && (
        <div className="color-picker" role="dialog" aria-label="Paint color">
          {/* The wheel's section: the left part of the panel, top to bottom, a little darker, with the wheel in its middle. */}
          <div className="color-wheel-section">
            <div className="color-wheel">
              <canvas
                ref={wheelRef}
                style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pickOnWheel(event);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) pickOnWheel(event);
                }}
                aria-label="Color wheel"
              />
              <span
                className="color-wheel-marker"
                style={{ left: WHEEL_SIZE / 2 + Math.cos(angle) * markerRadius, top: WHEEL_SIZE / 2 + Math.sin(angle) * markerRadius, background: hex }}
                aria-hidden="true"
              />
            </div>
          </div>
          {/* OK fills the bottom-right corner of the panel; the panel's rounded corner is its corner. */}
          <button className="color-ok" onClick={() => setOpen(false)}>OK</button>
          <div className="color-fields">
            {sliders.map(({ key, label, max, track }) => (
              <div className="color-field" key={key}>
                <label htmlFor={`color-${key}`}>{label}</label>
                <input
                  id={`color-${key}`}
                  type="range"
                  min={0}
                  max={max}
                  step={1}
                  value={Math.round(hsb[key])}
                  style={{ background: track }}
                  onChange={(event) => change({ ...hsb, [key]: Number(event.target.value) })}
                />
                <NumberField label={label === "H" ? "Hue" : label === "S" ? "Saturation" : "Brightness"} value={hsb[key]} max={max} onChange={(value) => change({ ...hsb, [key]: value })} />
              </div>
            ))}
            <div className="color-field">
              <label htmlFor="color-hex">Hex</label>
              <input
                id="color-hex"
                className="color-hex"
                type="text"
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
