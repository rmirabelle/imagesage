import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Adjustment, BlendMode, DocumentOrigin, EditStep, LayerAdjust, LayerPart } from "../editor/types";
import { ADJUSTMENT_FIELDS, ADJUSTMENT_LABELS, adjustList, allAdjustmentsOff, adjustmentNumber, type AdjustmentField } from "../editor/layers";
import {
  ArrowArcLeft,
  ArrowCounterClockwise,
  CaretDoubleLeft,
  Check,
  Checkerboard,
  CircleDashed,
  CircleHalf,
  CircleHalfTilt,
  ClipboardText,
  CloudFog,
  Copy,
  CornersOut,
  CursorClick,
  Drop,
  Eye,
  EyeSlash,
  Gradient,
  MagnifyingGlass,
  Plus,
  Prohibit,
  SlidersHorizontal,
  SpinnerGap,
  StopCircle,
  Sun,
  Trash,
  X
} from "@phosphor-icons/react";
import { modelLabel } from "../lib/ai";
import { MaskIcon } from "./MaskIcon";

/** What a chip menu (or a click on a chip) asks the editor to do with one part of a layer. */
export type PartAction =
  | "pick"
  | "linear"
  | "radial"
  | "add-mask"
  | "add-brightness"
  | "add-contrast"
  | "add-blur"
  | "add-hue-saturation"
  | "add-opacity"
  | "mask-add"
  | "mask-toggle"
  | "mask-invert"
  | "mask-delete"
  | "toggle"
  | "toggle-all"
  | "delete-all"
  | "reset"
  | "delete"
  | "resize"
  | "duplicate"
  | "click-select"
  | "mask-copy"
  | "mask-paste"
  | "blend-normal"
  | "blend-screen"
  | "blend-overlay";

interface Props {
  documentId: string;
  origin: DocumentOrigin;
  /** Adjustments of the original image. */
  baseAdjust?: LayerAdjust;
  history: EditStep[];
  /** The selected layer: 0 is the original image, n is history[n - 1]. */
  current: number;
  /** The part of the selected layer that the Mask tool paints into, or null when the Mask tool is off. */
  maskTarget: LayerPart | null;
  /** The red view of the target mask is on; the target mask then has a red border, else a blue one. */
  maskRedShown: boolean;
  /** A copied mask can be pasted. */
  canPasteMask: boolean;
  /** AI edits still running, newest first; each shows as a waiting row at the top of the list. */
  pending: PendingLayer[];
  /** Preview images by node key (see `stepKey`). */
  thumbnails: Record<string, string>;
  disabled: boolean;
  onSelect: (node: number) => void;
  /** Shows or hides a whole layer (not the original image). */
  /** `solo` (Ctrl+click) shows only this layer, or brings back the visibility from before. */
  onToggleVisible: (node: number, solo: boolean) => void;
  /** Shows (true) or hides (false) every layer; the original image always shows. */
  onShowAll: (visible: boolean) => void;
  onRetry: (node: number) => void;
  onDelete: (node: number) => void;
  /** An empty name removes the name, so the layer shows its prompt again. */
  onRename: (node: number, name: string) => void;
  /** Moves layer `from` directly above (or below) layer `to`. */
  onMove: (from: number, to: number, above: boolean) => void;
  /** A chip action on one part of a layer; `part` is unused for the add actions. */
  onPartAction: (node: number, part: LayerPart, action: PartAction) => void;
  /** Sets one number of one adjustment of a layer. */
  onAdjustValue: (node: number, id: string, field: AdjustmentField, value: number) => void;
}

/** An AI edit that is still running: its status, prompt, a short note (time, what it replaces), and Cancel while possible. */
export type PendingLayer = { id: string; status: string; prompt: string; note: string; onCancel?: () => void; selected: boolean; onSelect: () => void };

/** A layer being dragged to a new place: where it started, and where it would land. */
type LayerDrag = { from: number; pointerId: number; startY: number; moved: boolean; to: number | null; above: boolean };
/**
 * An open chip menu: for one part of a layer, or (with no part) the add menu.
 * `section` picks an adjustment's own items, the items of its mask, or the
 * items for all adjustments of the layer.
 */
type PartMenu = { node: number; part: LayerPart | null; section: "adjust" | "mask" | "all"; x: number; y: number };
/** Pointer travel, in CSS pixels, before a press on a layer becomes a drag. */
const DRAG_THRESHOLD = 5;

const WIDTH_KEY = "imagesage.steps-width";
/** Tells the other open tabs that the panel width changed. */
const WIDTH_EVENT = "imagesage-steps-width";
/** Narrower than this, the thumbnail, the name, and the chips no longer fit. */
const MIN_WIDTH = 260;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 300;
const clampWidth = (value: number) => Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value)));

const storedWidth = () => {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
};

const COLLAPSED_KEY = "imagesage.steps-collapsed";
/** Tells the other open tabs that the panel was collapsed or expanded. */
const COLLAPSED_EVENT = "imagesage-steps-collapsed";

const storedCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

const BLEND_LABELS: Record<BlendMode, string> = { screen: "Screen", overlay: "Overlay" };

/** The name a layer shows until the user renames it. */
const defaultLayerName = (node: number) => `Layer ${node}`;

/** A signed value, such as +30, −15 or 0. */
const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0";

/** The thumbnail key of a node; the original image has no step id of its own. */
export const stepKey = (documentId: string, history: EditStep[], node: number) =>
  node === 0 ? `origin:${documentId}` : history[node - 1].id;

/** A small view of a mask: white where it shows (or applies), black where it does not. */
function MaskThumb({ src, hides, off }: { src: string; hides: boolean; off: boolean }) {
  return (
    <span className={`chip-mask ${hides ? "hides" : ""} ${off ? "off" : ""}`} aria-hidden="true">
      <img src={src} alt="" draggable={false} />
    </span>
  );
}

/** The numbers of an adjustment as short text, such as "+20" or "+15° −30". Contrast shows its amount only. */
const adjustmentText = (adjustment: Adjustment) =>
  ADJUSTMENT_FIELDS[adjustment.kind].filter(({ field }) => adjustment.kind !== "contrast" || field === "value").map(({ field, unit, signed: withSign }) => {
    const number = adjustmentNumber(adjustment, field);
    return `${withSign ? signed(number) : number}${unit}`;
  }).join(" ");

/** The icon of a kind of adjustment. */
const AdjustmentIcon = ({ adjustment, size }: { adjustment: Pick<Adjustment, "kind">; size: number }) =>
  adjustment.kind === "hueSaturation" ? <Drop size={size} weight="bold" />
    : adjustment.kind === "contrast" ? <CircleHalfTilt size={size} weight="bold" />
    : adjustment.kind === "blur" ? <CloudFog size={size} weight="bold" />
    : adjustment.kind === "opacity" ? <Checkerboard size={size} weight="bold" />
    : <Sun size={size} weight="bold" />;

/** One slider row: the name on the left, the slider, and the number. */
function AdjustmentRow({ id, label, min, max, unit, neutral, withSign, value, disabled, onChange }: { id: string; label: string; min: number; max: number; unit: string; neutral: number; withSign: boolean; value: number; disabled: boolean; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const change = (next: number) => {
    setDraft(next);
    onChange(next);
  };
  return (
    <div className="layer-adjust-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={shown}
        disabled={disabled}
        onChange={(event) => change(Number(event.target.value))}
        onDoubleClick={() => change(neutral)}
        onPointerUp={(event) => { setDraft(null); event.currentTarget.blur(); }}
        onKeyUp={() => setDraft(null)}
        onBlur={() => setDraft(null)}
      />
      <output htmlFor={id}>{withSign ? signed(shown) : shown}{unit}</output>
    </div>
  );
}

/**
 * The sliders of the selected adjustment, under its layer: one for each of its
 * numbers. A value follows the pointer at once; the layer catches up on the
 * next frame. After a drag the slider gives focus back, so the number keys set
 * the mask brush opacity again.
 */
/**
 * Floats its content below the element just before it (an adjustment chip),
 * across the width of the chip strip; above the chip when the layers list would
 * cut it off below. It is placed after each render, because the chip's place
 * depends on how the chips wrap.
 */
function SliderPopover({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popover = ref.current;
    const chip = popover?.previousElementSibling as HTMLElement | null;
    if (!popover || !chip) return;
    const below = chip.offsetTop + chip.offsetHeight + 6;
    const above = chip.offsetTop - popover.offsetHeight - 6;
    const list = popover.closest(".steps-list")?.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const clipsBelow = list ? chipRect.bottom + 6 + popover.offsetHeight > list.bottom : false;
    const fitsAbove = list ? chipRect.top - 6 - popover.offsetHeight >= list.top : true;
    popover.style.top = `${clipsBelow && fitsAbove ? above : below}px`;
  });
  return <div ref={ref} className="layer-adjust-popover" onPointerDown={(event) => event.stopPropagation()}>{children}</div>;
}

function AdjustmentSliders({ node, adjustment, disabled, onChange }: { node: number; adjustment: Adjustment; disabled: boolean; onChange: (node: number, id: string, field: AdjustmentField, value: number) => void }) {
  return (
    <div className="layer-adjust-sliders">
      {ADJUSTMENT_FIELDS[adjustment.kind].map(({ field, label, min, max, unit, neutral, signed: withSign }) => (
        <AdjustmentRow
          key={field}
          id={`layer-adjust-${node}-${adjustment.id}-${field}`}
          label={label}
          min={min}
          max={max}
          unit={unit}
          neutral={neutral}
          withSign={withSign}
          value={adjustmentNumber(adjustment, field)}
          disabled={disabled}
          onChange={(value) => onChange(node, adjustment.id, field, value)}
        />
      ))}
    </div>
  );
}

/**
 * Lists every step as a layer, top layer first and the original image last.
 * Each layer covers the layers below it, except where its mask hides it.
 * Clicking a step selects that layer for mask painting, Retry, and Discard.
 * Under a layer, a strip shows one chip for its mask and one for each
 * adjustment; clicking a chip makes it the Mask tool's target, and its arrow
 * opens its options.
 */
export const StepsPanel = memo(function StepsPanel({ documentId, origin, baseAdjust, history, current, maskTarget, maskRedShown, canPasteMask, pending, thumbnails, disabled, onSelect, onToggleVisible, onShowAll, onRetry, onDelete, onRename, onMove, onPartAction, onAdjustValue }: Props) {
  /** The top layer is listed first, like a stack; the original image is at the bottom. */
  const nodes = Array.from({ length: history.length + 1 }, (_, node) => history.length - node);
  const [width, setWidth] = useState(storedWidth);
  /** The layer menu; `blendOnly` (from the blend tag) shows only the blend choices. */
  const [menu, setMenu] = useState<{ node: number; x: number; y: number; blendOnly?: boolean } | null>(null);
  const [partMenu, setPartMenu] = useState<PartMenu | null>(null);
  /** The adjustment whose slider is open, as "<layer key>:<adjustment id>"; a click on its chip opens or closes it. */
  const [openSlider, setOpenSlider] = useState<string | null>(null);
  /** Selecting another layer closes a slider that belongs to a different layer. */
  const currentKey = current > 0 ? history[current - 1]?.id ?? "" : "origin";
  useEffect(() => {
    setOpenSlider((open) => open && !open.startsWith(`${currentKey}:`) ? null : open);
  }, [currentKey]);

  /**
   * A newly added adjustment opens its slider. Only a new adjustment on a layer
   * that existed before counts, not a new or restored layer. The first pass
   * only records what exists.
   */
  const knownRef = useRef<{ layers: Set<string>; adjustments: Set<string> } | null>(null);
  useEffect(() => {
    const layers = ["origin", ...history.map((step) => step.id)];
    const adjustments = [
      ...adjustList(baseAdjust).map((item) => `origin:${item.id}`),
      ...history.flatMap((step) => adjustList(step.adjust).map((item) => `${step.id}:${item.id}`))
    ];
    const known = knownRef.current;
    knownRef.current = { layers: new Set(layers), adjustments: new Set(adjustments) };
    const added = known && adjustments.find((key) => !known.adjustments.has(key) && known.layers.has(key.slice(0, key.lastIndexOf(":adj-"))));
    if (added) setOpenSlider(added);
  }, [baseAdjust, history]);
  const [renaming, setRenaming] = useState<{ node: number; value: string } | null>(null);
  const [drag, setDrag] = useState<LayerDrag | null>(null);
  /** Filters the list by layer name, prompt and model; empty shows every layer. */
  const [search, setSearch] = useState("");
  const searchTerm = search.trim().toLowerCase();
  const layerText = (node: number) => {
    const step = node > 0 ? history[node - 1] : null;
    const parts = step
      ? [step.name || defaultLayerName(node), step.prompt, modelLabel(step.model)]
      : ["Original", origin.kind === "generated" ? origin.prompt : origin.fileName];
    return parts.join(" ").toLowerCase();
  };
  const shownNodes = searchTerm ? nodes.filter((node) => layerText(node).includes(searchTerm)) : nodes;
  const layerDragRef = useRef<LayerDrag | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  /**
   * The click that ends a drag must not also select the layer. That click
   * comes at once or not at all (the dropped row may move), so the guard lasts
   * only a moment; a guard that waited for a click could eat a later one.
   */
  const suppressClickUntilRef = useRef(0);
  const clickEndsDrag = () => performance.now() < suppressClickUntilRef.current;

  /** The selected layer scrolls into view when it changes, for example after a pick on the image. */
  useEffect(() => {
    /** Only the list scrolls; scrollIntoView could also scroll the app's own containers. */
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-node="${current}"]`);
    if (!list || !row) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
  }, [current]);

  /** The open adjustment sliders close on a press outside them (their chip toggles them itself) or on Escape. */
  useEffect(() => {
    if (!openSlider) return;
    const close = () => setOpenSlider(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openSlider]);

  /** The menus close on any outside press, Escape, or loss of focus. */
  useEffect(() => {
    if (!menu && !partMenu) return;
    const close = () => {
      setMenu(null);
      setPartMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [menu, partMenu]);

  /** Opens a chip menu under (or, near the bottom of the window, above) its button. */
  const openPartMenu = (anchor: HTMLElement, node: number, part: LayerPart | null, section: PartMenu["section"] = "adjust") => {
    const rect = anchor.getBoundingClientRect();
    const height = section === "all" ? 70 : part === null ? 160 : part === "mask" || section === "mask" ? 230 : 240;
    const y = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    setMenu(null);
    setOpenSlider(null);
    setPartMenu({ node, part, section, x: Math.min(rect.left, window.innerWidth - 220), y });
  };

  const runPart = (node: number, part: LayerPart, action: PartAction) => {
    setPartMenu(null);
    setMenu(null);
    onPartAction(node, part, action);
  };

  const updateDrag = (next: LayerDrag | null) => {
    layerDragRef.current = next;
    setDrag(next);
  };

  /** The layer row under a pointer position, and whether the pointer is in its upper half. */
  const dropTarget = (clientY: number): { to: number; above: boolean } | null => {
    const rows = listRef.current?.querySelectorAll<HTMLLIElement>("li[data-node]") ?? [];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const to = Number(row.dataset.node);
      return { to, above: to === 0 || clientY < rect.top + rect.height / 2 };
    }
    return null;
  };

  const startLayerDrag = (event: ReactPointerEvent<HTMLButtonElement>, node: number) => {
    if (event.button !== 0 || node === 0 || disabled) return;
    updateDrag({ from: node, pointerId: event.pointerId, startY: event.clientY, moved: false, to: null, above: true });
  };

  const moveLayerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = layerDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!active.moved && Math.abs(event.clientY - active.startY) < DRAG_THRESHOLD) return;
    if (!active.moved) event.currentTarget.setPointerCapture(event.pointerId);
    const target = dropTarget(event.clientY);
    updateDrag({ ...active, moved: true, to: target?.to ?? null, above: target?.above ?? true });
  };

  const endLayerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = layerDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    updateDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!active.moved) return;
    suppressClickUntilRef.current = performance.now() + 300;
    if (active.to !== null && active.to !== active.from) onMove(active.from, active.to, active.above);
  };

  /** An empty name goes back to the default name ("Layer N"). */
  const finishRename = (commit: boolean) => {
    if (renaming && commit) onRename(renaming.node, renaming.value.trim());
    setRenaming(null);
  };
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onWidth = (event: Event) => setWidth((event as CustomEvent<number>).detail);
    window.addEventListener(WIDTH_EVENT, onWidth);
    return () => window.removeEventListener(WIDTH_EVENT, onWidth);
  }, []);

  /** The panel can collapse to a thin strip on the right edge; every tab follows. */
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  useEffect(() => {
    const onCollapsed = (event: Event) => setCollapsed((event as CustomEvent<boolean>).detail);
    window.addEventListener(COLLAPSED_EVENT, onCollapsed);
    return () => window.removeEventListener(COLLAPSED_EVENT, onCollapsed);
  }, []);
  const changeCollapsed = (next: boolean) => {
    setMenu(null);
    setPartMenu(null);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* A remembered state is a convenience only. */
    }
    window.dispatchEvent(new CustomEvent(COLLAPSED_EVENT, { detail: next }));
  };

  /** The handle is on the left edge, so dragging left makes the panel wider. */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) setWidth(clampWidth(drag.startWidth + drag.startX - event.clientX));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* A remembered width is a convenience only. */
    }
    window.dispatchEvent(new CustomEvent(WIDTH_EVENT, { detail: width }));
  };

  /** The adjustments of a node; the original image keeps its own on the document. */
  const adjustOf = (node: number) => adjustList(node > 0 ? history[node - 1].adjust : baseAdjust);

  /** The chips under one layer: its mask, then its adjustments in order, then the add button. */
  const renderStrip = (node: number) => {
    const step = node > 0 ? history[node - 1] : null;
    const adjust = adjustOf(node) ?? [];
    const selected = node === current;
    const layerKey = step?.id ?? "origin";
    const chip = (part: LayerPart) => {
      const isMask = part === "mask";
      const adjustment = isMask ? undefined : adjust.find((item) => item.id === part);
      const mask = isMask ? step?.layerMask : adjustment?.mask;
      const hides = isMask ? step?.maskHides === true : adjustment?.maskHides === true;
      const maskOff = isMask ? step?.maskOff === true : adjustment?.maskOff === true;
      const off = isMask ? maskOff : adjustment?.off === true;
      const name = adjustment ? ADJUSTMENT_LABELS[adjustment.kind] : "Mask";
      const label = isMask || !adjustment ? "Layer mask" : `${name} ${adjustmentText(adjustment)}`;
      return (
        <div
          key={part}
          className={`layer-chip ${isMask ? "" : "adjust"} ${openSlider === `${layerKey}:${part}` ? "open" : ""} ${selected && maskTarget === part ? `target ${maskRedShown ? "red" : ""}` : ""} ${off ? "off" : ""}`}
          onContextMenu={(event) => {
            event.preventDefault();
            /** The chip's options menu replaces its open sliders. */
            setOpenSlider(null);
            if (disabled) return;
            openPartMenu(event.currentTarget, node, part);
          }}
        >
          {isMask ? (
            <button
              className="layer-chip-body"
              disabled={disabled}
              onClick={() => onPartAction(node, part, "pick")}
              data-help={`${label}${off ? " (turned off)" : ""}. Click to paint it with the Mask tool. Right-click for options.`}
            >
              <MaskIcon inverted={hides} size={15} />
              {mask && <MaskThumb src={mask} hides={hides} off={maskOff} />}
            </button>
          ) : (
            <>
              <button
                className="layer-chip-body"
                disabled={disabled}
                aria-expanded={openSlider === `${layerKey}:${part}`}
                onPointerDown={(event) => {
                  /** The press must not reach the sliders' outside-press close, so it closes the menus itself. */
                  event.stopPropagation();
                  setMenu(null);
                  setPartMenu(null);
                }}
                onClick={() => {
                  if (!selected) onSelect(node);
                  /** A turned-off adjustment turns on first, so its sliders change what you see. */
                  if (adjustment?.off) {
                    onPartAction(node, part, "toggle");
                    setOpenSlider(`${layerKey}:${part}`);
                    return;
                  }
                  setOpenSlider((open) => open === `${layerKey}:${part}` ? null : `${layerKey}:${part}`);
                }}
                data-help={`${label}${off ? " (turned off)" : ""}. Click to edit. Right-click for options.`}
              >
                {adjustment && <AdjustmentIcon adjustment={adjustment} size={14} />}
                {adjustment && <span className="layer-chip-value">{adjustmentText(adjustment)}</span>}
              </button>
              {mask && (
                <button
                  className="layer-chip-mask"
                  disabled={disabled}
                  onClick={() => {
                    if (adjustment?.off) onPartAction(node, part, "toggle");
                    onPartAction(node, part, "pick");
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!disabled) openPartMenu(event.currentTarget, node, part, "mask");
                  }}
                  data-help={`The mask of ${name.toLowerCase()}. Click to paint it with the Mask tool; click again to stop. Right-click for the mask options.`}
                >
                  <MaskThumb src={mask} hides={hides} off={maskOff} />
                </button>
              )}
            </>
          )}
        </div>
      );
    };
    /** The layer mask shows on the layer thumbnail instead, so the strip holds only adjustments. */
    const parts: LayerPart[] = adjust.map((item) => item.id);
    const sliderOf = adjust.find((item) => openSlider === `${layerKey}:${item.id}`);
    return (
      <>
        <div className={`layer-strip ${parts.length ? "" : "empty"}`}>
          {parts.length > 0 && (
            /** In the eye column, left of the first chip: shows or hides all adjustments of this layer. */
            <button
              className={`adjust-all-toggle ${allAdjustmentsOff(adjust) ? "off" : ""}`}
              disabled={disabled}
              aria-pressed={!allAdjustmentsOff(adjust)}
              aria-label={allAdjustmentsOff(adjust) ? "Enable all adjustments" : "Disable all adjustments"}
              onClick={() => onPartAction(node, "mask", "toggle-all")}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!disabled) openPartMenu(event.currentTarget, node, null, "all");
              }}
              data-help={allAdjustmentsOff(adjust) ? "All adjustments are disabled. Click to enable them again. Right-click to delete them." : "Disable all adjustments of this layer. Click again to enable them. Right-click to delete them."}
            >
              <SlidersHorizontal size={15} />
            </button>
          )}
          {/* An open adjustment's sliders float above its chip. */}
          {parts.map((part) => (
            <Fragment key={part}>
              {chip(part)}
              {sliderOf?.id === part && (
                <SliderPopover>
                  <AdjustmentSliders node={node} adjustment={sliderOf} disabled={disabled} onChange={onAdjustValue} />
                </SliderPopover>
              )}
            </Fragment>
          ))}
          {/* A layer without a mask offers the layer mask menu here, so it needs no right-click. */}
          {step && !step.layerMask && (
            <button
              className="layer-strip-add"
              disabled={disabled}
              aria-haspopup="menu"
              data-help="Add a layer mask to this layer"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => partMenu?.node === node && partMenu.part === "mask" ? setPartMenu(null) : openPartMenu(event.currentTarget, node, "mask")}
            >
              <Plus size={12} weight="bold" />
              <span>Layer Mask</span>
            </button>
          )}
          <button
            className="layer-strip-add"
            disabled={disabled}
            aria-haspopup="menu"
            data-help="Add an adjustment to this layer"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => partMenu?.node === node && partMenu.part === null ? setPartMenu(null) : openPartMenu(event.currentTarget, node, null)}
          >
            <Plus size={12} weight="bold" />
            {!parts.length && <span>Adjustment</span>}
          </button>
        </div>
      </>
    );
  };

  /**
   * A layer thumbnail. With a layer mask, the mask shows in its bottom-left
   * corner: a click on the mask picks it for painting (again: shows or hides
   * the red view), and a right-click on it opens the mask menu.
   */
  const renderThumb = (node: number, thumbnail: string | undefined) => {
    const step = node > 0 ? history[node - 1] : null;
    const image = thumbnail ? <img src={thumbnail} alt="" /> : null;
    if (!step?.layerMask) return <span className="steps-thumb">{image}</span>;
    const targeted = node === current && maskTarget === "mask";
    /** A click here must not also select the layer through the row, and not right after a layer drag. */
    const handled = (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (clickEndsDrag()) return false;
      if (disabled) return false;
      if (node !== current) onSelect(node);
      return true;
    };
    return (
      <span className="steps-thumb">
        {image}
        <span
          className={`thumb-mask ${targeted ? "target" : ""} ${targeted && maskRedShown ? "red" : ""}`}
          data-help={`Layer mask${step.maskOff ? " (turned off)" : ""}. Click to paint it with the Mask tool; click again to stop. Right-click for the mask options.`}
          onClick={(event) => { if (handled(event)) onPartAction(node, "mask", "pick"); }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (handled(event)) openPartMenu(event.currentTarget, node, "mask");
          }}
        >
          <MaskThumb src={step.layerMask} hides={step.maskHides === true} off={step.maskOff === true} />
        </span>
      </span>
    );
  };

  /** The items of the open chip menu. */
  const renderPartMenu = (open: PartMenu) => {
    const { node } = open;
    const step = node > 0 ? history[node - 1] : null;
    const item = (part: LayerPart, action: PartAction, icon: ReactNode, label: string, extra: { danger?: boolean; disabled?: boolean; note?: string } = {}) => (
      <button key={`${part}-${action}`} role="menuitem" className={extra.danger ? "danger" : ""} disabled={extra.disabled} onClick={() => runPart(node, part, action)}>
        {icon} <span className="steps-menu-label">{label}</span>{extra.note && <small>{extra.note}</small>}
      </button>
    );
    if (open.section === "all") {
      return [
        <div key="head" className="steps-menu-head">All adjustments</div>,
        item("mask", "delete-all", <Trash size={15} />, "Delete all adjustments", { danger: true })
      ];
    }
    if (open.part === null) {
      return [
        <div key="head" className="steps-menu-head">Adjust {node > 0 ? step?.name || defaultLayerName(node) : "Original"}</div>,
        item("mask", "add-brightness", <Sun size={15} />, "Brightness"),
        item("mask", "add-contrast", <CircleHalfTilt size={15} />, "Contrast"),
        item("mask", "add-blur", <CloudFog size={15} />, "Blur"),
        item("mask", "add-hue-saturation", <Drop size={15} />, "Hue/Saturation"),
        item("mask", "add-opacity", <Checkerboard size={15} />, "Opacity"),
      ];
    }
    const part = open.part;
    const adjustment = part === "mask" ? undefined : adjustOf(node).find((entry) => entry.id === part);
    const hasMask = part === "mask" ? Boolean(step?.layerMask) : Boolean(adjustment?.mask);
    const maskOff = part === "mask" ? step?.maskOff === true : adjustment?.maskOff === true;
    const maskItems = [
      /** Enable or Disable comes first in every mask menu; Add mask comes first while there is no mask. */
      hasMask
        ? item(part, "mask-toggle", <Prohibit size={15} />, maskOff ? "Enable mask" : "Disable mask")
        : item(part, part === "mask" ? "add-mask" : "mask-add", <MaskIcon size={15} />, "Add mask", { note: part === "mask" ? "Ctrl+M · hides all" : "hides all" }),
      item(part, "click-select", <CursorClick size={15} />, "Click to select…", { note: "click the image" }),
      ...(hasMask ? [item(part, "mask-invert", <CircleHalf size={15} />, "Invert mask")] : []),
      ...(hasMask ? [item(part, "mask-copy", <Copy size={15} />, "Copy mask")] : []),
      ...(canPasteMask ? [item(part, "mask-paste", <ClipboardText size={15} />, "Paste mask", { note: hasMask ? "replaces this one" : undefined })] : []),
      item(part, "linear", <Gradient size={15} />, "Linear gradient", { note: "drag on image" }),
      item(part, "radial", <CircleDashed size={15} />, "Radial gradient", { note: "drag on image" }),
      ...(hasMask ? [item(part, "mask-delete", <Trash size={15} />, "Delete mask", { danger: true })] : [])
    ];
    if (part === "mask" || !adjustment) return [<div key="head" className="steps-menu-head">Layer mask</div>, ...maskItems];
    const name = ADJUSTMENT_LABELS[adjustment.kind];
    /** The mask thumbnail has its own menu; the adjustment's menu offers only ways to add a mask, while it has none. */
    if (open.section === "mask" && hasMask) return [<div key="head" className="steps-menu-head">{name} mask</div>, ...maskItems];
    return [
      <div key="head" className="steps-menu-head">{name}</div>,
      item(part, "toggle", <Prohibit size={15} />, adjustment.off ? `Enable ${name.toLowerCase()}` : `Disable ${name.toLowerCase()}`),
      item(part, "reset", <ArrowCounterClockwise size={15} />, "Reset to 0"),
      ...(hasMask ? [] : [<div key="sep-1" className="steps-menu-divider" />, ...maskItems]),
      <div key="sep-2" className="steps-menu-divider" />,
      item(part, "delete", <Trash size={15} />, `Delete ${name.toLowerCase()}`, { danger: true })
    ];
  };

  return (
    collapsed ? (
      <aside className="steps-panel collapsed" aria-label="Layers (collapsed)" data-help-side="left">
        <button className="steps-expand" onClick={() => changeCollapsed(false)} aria-label="Expand the layers panel" data-help="Expand the layers panel">
          <CaretDoubleLeft size={14} weight="bold" />
          <span className="steps-collapsed-label">Layers · {history.length + 1}</span>
          {pending.length > 0 && <SpinnerGap className="spin" size={15} />}
        </button>
      </aside>
    ) :
    <aside className="steps-panel" aria-label="Layers" style={{ width }} data-help-side="left">
      <div
        className="steps-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the layers panel"
        data-help="Drag to resize"
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className="steps-panel-header" role="toolbar" aria-label="Layers">
        <span className="steps-panel-title">{history.length + 1} {history.length ? "Layers" : "Layer"}</span>
        <label className={`layers-search ${search ? "has-value" : ""}`} data-help="Filter the layers by name, prompt or model. Esc clears.">
          <MagnifyingGlass size={13} weight="bold" />
          <input
            type="text"
            placeholder="Filter"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                setSearch("");
              }
            }}
            aria-label="Filter layers"
            spellCheck={false}
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} aria-label="Clear filter" data-help="Clear">
              <X size={11} weight="bold" />
            </button>
          )}
        </label>
        <div className="steps-show" role="group" aria-label="Show layers">
          <span className="steps-show-label">Show</span>
          <div className="split-button">
            <button
              disabled={disabled || !history.length || history.every((step) => !step.hidden)}
              onClick={() => onShowAll(true)}
              data-help="Show every layer"
            >
              All
            </button>
            <button
              disabled={disabled || !history.length || history.every((step) => step.hidden)}
              onClick={() => onShowAll(false)}
              data-help="Hide every layer; the original image still shows"
            >
              None
            </button>
          </div>
        </div>
        <button className="steps-collapse" onClick={() => changeCollapsed(true)} aria-label="Close the layers panel" data-help="Close the layers panel">
          <X size={12} weight="bold" />
        </button>
      </div>
      <ol className="steps-list" ref={listRef}>
        {pending.map((item) => (
          <li key={item.id} className={`steps-row pending-row ${item.selected ? "active" : ""}`} aria-busy="true" onClick={item.onSelect}>
            <span className="steps-eye-spacer" aria-hidden="true" />
            <div className="steps-card">
              <div className="steps-item" data-help={`${item.prompt}

Click to show its progress on the image.`}>
                <span className="steps-thumb pending-thumb"><SpinnerGap className="spin" size={22} /></span>
                <span className="steps-text">
                  <strong className="steps-name">{item.status}</strong>
                  <span className="steps-prompt">{item.prompt}</span>
                  <small>{item.note}</small>
                </span>
              </div>
              {item.onCancel && (
                <div className="layer-strip">
                  <button className="layer-strip-add" onClick={(event) => { event.stopPropagation(); item.onCancel?.(); }} data-help="Cancel this AI edit">
                    <StopCircle size={12} weight="bold" /> <span>Cancel</span>
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
        {searchTerm && !shownNodes.length && <li className="steps-empty">No layers match “{search.trim()}”.</li>}
        {shownNodes.map((node) => {
          const step = node > 0 ? history[node - 1] : null;
          const prompt = step
            ? step.prompt
            : origin.kind === "generated" ? origin.prompt : origin.fileName || "Opened image";
          const name = step ? step.name || defaultLayerName(node) : "Original";
          const thumbnail = thumbnails[stepKey(documentId, history, node)];
          const dropClass = drag?.moved && drag.to === node && drag.from !== node ? (drag.above ? "drop-above" : "drop-below") : "";
          return (
            <li
              key={step?.id ?? "origin"}
              data-node={node}
              className={`steps-row ${node === current && !pending.some((item) => item.selected) ? "active" : ""} ${step?.hidden ? "hidden-layer" : ""} ${dropClass} ${drag?.moved && drag.from === node ? "dragging" : ""}`}
            >
              {step ? (
                <button
                  className="steps-eye"
                  disabled={disabled}
                  onClick={(event) => onToggleVisible(node, event.ctrlKey)}
                  aria-label={step.hidden ? `Show layer ${node + 1}` : `Hide layer ${node + 1}`}
                  aria-pressed={!step.hidden}
                  data-help={`${step.hidden ? "Show this layer" : "Hide this layer"}.\nCtrl + click to toggle solo`}
                >
                  {step.hidden ? <EyeSlash size={15} /> : <Eye size={15} />}
                </button>
              ) : <span className="steps-eye-spacer" aria-hidden="true" />}
              <div className={`steps-card ${node === current ? "active" : ""}`}>
                {renaming?.node === node ? (
                  /** While renaming, the row is not a button, so the name field gets normal focus and keys. */
                  <div className="steps-item editing">
                    <span className="steps-thumb">{thumbnail ? <img src={thumbnail} alt="" /> : null}</span>
                    <span className="steps-text">
                      <input
                        className="steps-rename"
                        autoFocus
                        value={renaming.value}
                        placeholder={defaultLayerName(node)}
                        aria-label="Layer name"
                        onChange={(event) => setRenaming({ node, value: event.target.value })}
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") finishRename(true);
                          if (event.key === "Escape") finishRename(false);
                        }}
                        onBlur={() => finishRename(true)}
                      />
                      <span className="steps-prompt">{prompt}</span>
                    </span>
                  </div>
                ) : (
                  <button
                    className="steps-item"
                    disabled={disabled}
                    aria-current={node === current ? "step" : undefined}
                    onClick={() => {
                      if (clickEndsDrag()) return;
                      onSelect(node);
                    }}
                    onDoubleClick={() => step && setRenaming({ node, value: step.name ?? "" })}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (disabled) return;
                      onSelect(node);
                      setPartMenu(null);
                      setMenu({ node, x: Math.min(event.clientX, window.innerWidth - 230), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260)) });
                    }}
                    onPointerDown={(event) => startLayerDrag(event, node)}
                    onPointerMove={moveLayerDrag}
                    onPointerUp={endLayerDrag}
                    onPointerCancel={endLayerDrag}
                    data-help={step ? "Double-click to rename layer. Right-click for layer options. Drag up/down to sort." : "The original image. Right-click to duplicate it."}
                  >
                    {renderThumb(node, thumbnail)}
                    <span className="steps-text">
                      <strong className="steps-name">{name}</strong>
                      {!step?.name && <span className="steps-prompt">{prompt}</span>}
                      <small>
                        {step ? modelLabel(step.model) : origin.kind === "generated" ? modelLabel(origin.model) : "Original"}
                        {step && (
                          <span
                            className={`blend-tag ${step.blend ? "" : "normal"}`}
                            role="button"
                            tabIndex={-1}
                            data-help="Layer blend mode. Click to change"
                            data-help-one-line
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (disabled) return;
                              const rect = event.currentTarget.getBoundingClientRect();
                              setPartMenu(null);
                              setMenu({ node, x: Math.min(rect.left, window.innerWidth - 170), y: Math.min(rect.bottom + 4, window.innerHeight - 140), blendOnly: true });
                            }}
                          >
                            {step.blend ? BLEND_LABELS[step.blend] : "Normal"}
                          </span>
                        )}
                      </small>
                    </span>
                  </button>
                )}
                {renderStrip(node)}
              </div>
            </li>
          );
        })}
      </ol>
      {menu && (() => {
        const currentMode = history[menu.node - 1]?.blend ?? "normal";
        const blendItems = (["normal", "screen", "overlay"] as const).map((mode) => (
          <button key={mode} role="menuitemradio" aria-checked={currentMode === mode} onClick={() => { onPartAction(menu.node, "mask", `blend-${mode}`); setMenu(null); }}>
            <span className="steps-menu-check">{currentMode === mode && <Check size={13} weight="bold" />}</span>
            {mode === "normal" ? "Normal" : BLEND_LABELS[mode]}
          </button>
        ));
        if (menu.blendOnly) {
          return (
            <div className="steps-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
              <div className="steps-menu-head">Layer blend mode</div>
              {blendItems}
            </div>
          );
        }
        const plain = (icon: ReactNode, label: ReactNode, run: () => void, danger = false) => (
          <button role="menuitem" className={danger ? "danger" : ""} onClick={() => { run(); setMenu(null); }}>
            {icon} {label}
          </button>
        );
        const step = history[menu.node - 1];
        return (
          <div className="steps-menu layer-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="steps-menu-head">{step ? "Edit layer" : "Original image"}</div>
            {/* The original image can only be duplicated; the copy is a normal layer. */}
            {!step && plain(<Copy size={15} />, <>Duplicate <small>Ctrl+J</small></>, () => onPartAction(menu.node, "mask", "duplicate"))}
            {step && plain(<CornersOut size={15} />, <>Transform <small>Ctrl+T</small></>, () => onPartAction(menu.node, "mask", "resize"))}
            {step && plain(<Copy size={15} />, <>Duplicate <small>Ctrl+J</small></>, () => onPartAction(menu.node, "mask", "duplicate"))}
            {step && plain(<ArrowArcLeft size={15} />, "Regenerate", () => onRetry(menu.node))}
            {step && plain(<Trash size={15} />, <>Delete <small>Del</small></>, () => onDelete(menu.node), true)}
          </div>
        );
      })()}
      {partMenu && (
        <div className="steps-menu part-menu" role="menu" style={{ left: partMenu.x, top: partMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {renderPartMenu(partMenu)}
        </div>
      )}
    </aside>
  );
});
