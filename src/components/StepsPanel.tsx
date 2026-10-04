import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Adjustment, DocumentOrigin, EditStep, LayerAdjust, LayerPart } from "../editor/types";
import { ADJUSTMENT_FIELDS, ADJUSTMENT_LABELS, adjustList, allAdjustmentsOff, adjustmentNumber, type AdjustmentField } from "../editor/layers";
import {
  ArrowArcLeft,
  ArrowCounterClockwise,
  CaretDown,
  Checkerboard,
  CircleDashed,
  CircleHalf,
  CornersOut,
  Drop,
  Eye,
  EyeSlash,
  Gradient,
  PencilSimple,
  Plus,
  Prohibit,
  SlidersHorizontal,
  SpinnerGap,
  StopCircle,
  Sun,
  Trash
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
  | "add-hue-saturation"
  | "add-opacity"
  | "mask-add"
  | "mask-toggle"
  | "mask-invert"
  | "mask-delete"
  | "toggle"
  | "toggle-all"
  | "reset"
  | "delete"
  | "resize";

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
  /** AI edits still running, newest first; each shows as a waiting row at the top of the list. */
  pending: PendingLayer[];
  /** Preview images by node key (see `stepKey`). */
  thumbnails: Record<string, string>;
  disabled: boolean;
  onSelect: (node: number) => void;
  /** Shows or hides a whole layer (not the original image). */
  onToggleVisible: (node: number) => void;
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
/** An open chip menu: for one part of a layer, or (with no part) the add menu. */
type PartMenu = { node: number; part: LayerPart | null; x: number; y: number };
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

/** The numbers of an adjustment as short text, such as "+20" or "+15° −30". */
const adjustmentText = (adjustment: Adjustment) =>
  ADJUSTMENT_FIELDS[adjustment.kind].map(({ field, unit, signed: withSign }) => {
    const number = adjustmentNumber(adjustment, field);
    return `${withSign ? signed(number) : number}${unit}`;
  }).join(" ");

/** The icon of a kind of adjustment. */
const AdjustmentIcon = ({ adjustment, size }: { adjustment: Pick<Adjustment, "kind">; size: number }) =>
  adjustment.kind === "hueSaturation" ? <Drop size={size} weight="bold" />
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
        data-help="Drag to change; double-click to reset"
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
export const StepsPanel = memo(function StepsPanel({ documentId, origin, baseAdjust, history, current, maskTarget, maskRedShown, pending, thumbnails, disabled, onSelect, onToggleVisible, onShowAll, onRetry, onDelete, onRename, onMove, onPartAction, onAdjustValue }: Props) {
  /** The top layer is listed first, like a stack; the original image is at the bottom. */
  const nodes = Array.from({ length: history.length + 1 }, (_, node) => history.length - node);
  const [width, setWidth] = useState(storedWidth);
  const [menu, setMenu] = useState<{ node: number; x: number; y: number } | null>(null);
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
  const layerDragRef = useRef<LayerDrag | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  /** The click that ends a drag must not also select the layer. */
  const suppressClickRef = useRef(false);

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
  const openPartMenu = (anchor: HTMLElement, node: number, part: LayerPart | null) => {
    const rect = anchor.getBoundingClientRect();
    const height = part === null ? 160 : part === "mask" ? 190 : 330;
    const y = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    setMenu(null);
    setPartMenu({ node, part, x: Math.min(rect.left, window.innerWidth - 220), y });
  };

  const runPart = (node: number, part: LayerPart, action: PartAction) => {
    setPartMenu(null);
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
    suppressClickRef.current = true;
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
          className={`layer-chip ${isMask ? "" : "adjust"} ${selected && maskTarget === part ? `target ${maskRedShown ? "red" : ""}` : ""} ${off ? "off" : ""}`}
          onContextMenu={(event) => {
            event.preventDefault();
            if (disabled) return;
            openPartMenu(event.currentTarget, node, part);
          }}
        >
          {isMask ? (
            <button
              className="layer-chip-body"
              disabled={disabled}
              onClick={() => onPartAction(node, part, "pick")}
              data-help={`${label}${off ? " (turned off)" : ""}. Click to paint it with the Mask tool. Right-click or use the arrow for options.`}
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
                onClick={() => {
                  if (!selected) onSelect(node);
                  setOpenSlider((open) => open === `${layerKey}:${part}` ? null : `${layerKey}:${part}`);
                }}
                data-help={`${label}${off ? " (turned off)" : ""}. Click to show or hide its slider. Right-click or use the arrow for options.`}
              >
                {adjustment && <AdjustmentIcon adjustment={adjustment} size={14} />}
                {adjustment && <span className="layer-chip-value">{adjustmentText(adjustment)}</span>}
              </button>
              {mask && (
                <button
                  className="layer-chip-mask"
                  disabled={disabled}
                  onClick={() => onPartAction(node, part, "pick")}
                  data-help={`The mask of ${name.toLowerCase()}. Click to paint it with the Mask tool; click again to show or hide the red view.`}
                >
                  <MaskThumb src={mask} hides={hides} off={maskOff} />
                </button>
              )}
            </>
          )}
          <button
            className="layer-chip-caret"
            disabled={disabled}
            aria-label={`${name} options`}
            aria-haspopup="menu"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => partMenu?.node === node && partMenu.part === part ? setPartMenu(null) : openPartMenu(event.currentTarget, node, part)}
          >
            <CaretDown size={11} weight="bold" />
          </button>
        </div>
      );
    };
    /** The layer mask shows on the layer thumbnail instead, so the strip holds only adjustments. */
    const parts: LayerPart[] = adjust.map((item) => item.id);
    /** The original image cannot have a layer mask, and a layer has at most one. */
    const canAddMask = node > 0 && !step?.layerMask;
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
              aria-label={allAdjustmentsOff(adjust) ? "Turn on all adjustments" : "Turn off all adjustments"}
              onClick={() => onPartAction(node, "mask", "toggle-all")}
              data-help={allAdjustmentsOff(adjust) ? "All adjustments are off. Click to turn them on again." : "Turn off all adjustments of this layer. Click again to turn them back on."}
            >
              <SlidersHorizontal size={15} />
            </button>
          )}
          {parts.map(chip)}
          <button
            className="layer-strip-add"
            disabled={disabled}
            aria-haspopup="menu"
            data-help={canAddMask ? "Add a mask or an adjustment to this layer" : "Add an adjustment to this layer"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => partMenu?.node === node && partMenu.part === null ? setPartMenu(null) : openPartMenu(event.currentTarget, node, null)}
          >
            <Plus size={12} weight="bold" />
            {!parts.length && <span>{canAddMask ? "Add mask or adjustment" : "Add adjustment"}</span>}
          </button>
        </div>
        {sliderOf && <AdjustmentSliders key={sliderOf.id} node={node} adjustment={sliderOf} disabled={disabled} onChange={onAdjustValue} />}
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
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return false;
      }
      if (disabled) return false;
      if (node !== current) onSelect(node);
      return true;
    };
    return (
      <span className="steps-thumb">
        {image}
        <span
          className={`thumb-mask ${targeted ? "target" : ""} ${targeted && maskRedShown ? "red" : ""}`}
          data-help={`Layer mask${step.maskOff ? " (turned off)" : ""}. Click to paint it with the Mask tool; click again to show or hide the red view. Right-click for the mask options.`}
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
    if (open.part === null) {
      return [
        <div key="head" className="steps-menu-head">Add to {node > 0 ? step?.name || defaultLayerName(node) : "Original"}</div>,
        item("mask", "add-mask", <MaskIcon size={15} />, "Mask", { disabled: node === 0 || Boolean(step?.layerMask), note: node === 0 ? "not on the original" : "hides all" }),
        item("mask", "add-brightness", <Sun size={15} />, "Brightness"),
        item("mask", "add-hue-saturation", <Drop size={15} />, "Hue/Saturation"),
        item("mask", "add-opacity", <Checkerboard size={15} />, "Opacity")
      ];
    }
    const part = open.part;
    const adjustment = part === "mask" ? undefined : adjustOf(node).find((entry) => entry.id === part);
    const hasMask = part === "mask" ? Boolean(step?.layerMask) : Boolean(adjustment?.mask);
    const maskOff = part === "mask" ? step?.maskOff === true : adjustment?.maskOff === true;
    const maskItems = [
      ...(hasMask
        ? [
          item(part, "mask-toggle", <Prohibit size={15} />, maskOff ? "Turn on mask" : "Turn off mask"),
          item(part, "mask-invert", <CircleHalf size={15} />, "Invert mask")
        ]
        : [item(part, "mask-add", <MaskIcon size={15} />, "Add mask", { note: "hides all" })]),
      item(part, "linear", <Gradient size={15} />, "Linear gradient", { note: "drag on image" }),
      item(part, "radial", <CircleDashed size={15} />, "Radial gradient", { note: "drag on image" }),
      ...(hasMask ? [item(part, "mask-delete", <Trash size={15} />, "Delete mask", { danger: true })] : [])
    ];
    if (part === "mask" || !adjustment) return [<div key="head" className="steps-menu-head">Layer mask</div>, ...maskItems];
    const name = ADJUSTMENT_LABELS[adjustment.kind];
    return [
      <div key="head" className="steps-menu-head">{name}</div>,
      item(part, "toggle", <Prohibit size={15} />, adjustment.off ? `Turn on ${name.toLowerCase()}` : `Turn off ${name.toLowerCase()}`),
      item(part, "reset", <ArrowCounterClockwise size={15} />, "Reset to 0"),
      <div key="sep-1" className="steps-menu-divider" />,
      ...maskItems,
      <div key="sep-2" className="steps-menu-divider" />,
      item(part, "delete", <Trash size={15} />, `Delete ${name.toLowerCase()}`, { danger: true })
    ];
  };

  return (
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
      <div className="steps-panel-header">
        <span className="steps-panel-title">Layers</span>
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
        {nodes.map((node) => {
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
                  onClick={() => onToggleVisible(node)}
                  aria-label={step.hidden ? `Show layer ${node + 1}` : `Hide layer ${node + 1}`}
                  aria-pressed={!step.hidden}
                  data-help={step.hidden ? "Show this layer" : "Hide this layer"}
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
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      onSelect(node);
                    }}
                    onDoubleClick={() => step && setRenaming({ node, value: step.name ?? "" })}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (disabled || !step) return;
                      onSelect(node);
                      setPartMenu(null);
                      setMenu({ node, x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 150) });
                    }}
                    onPointerDown={(event) => startLayerDrag(event, node)}
                    onPointerMove={moveLayerDrag}
                    onPointerUp={endLayerDrag}
                    onPointerCancel={endLayerDrag}
                    data-help={step ? "Click to select the layer. Double-click to rename it. Right-click for Rename, Transform, Retry and Delete. Drag to move the layer." : "The original image. Click to select it."}
                  >
                    {renderThumb(node, thumbnail)}
                    <span className="steps-text">
                      <strong className="steps-name">{name}</strong>
                      {!step?.name && <span className="steps-prompt">{prompt}</span>}
                      <small>{step ? modelLabel(step.model) : origin.kind === "generated" ? modelLabel(origin.model) : "Original"}</small>
                    </span>
                  </button>
                )}
                {renderStrip(node)}
              </div>
            </li>
          );
        })}
      </ol>
      {menu && (
        <div className="steps-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button role="menuitem" onClick={() => { setRenaming({ node: menu.node, value: history[menu.node - 1]?.name ?? "" }); setMenu(null); }}>
            <PencilSimple size={15} /> Rename
          </button>
          <button role="menuitem" onClick={() => { onPartAction(menu.node, "mask", "resize"); setMenu(null); }}>
            <CornersOut size={15} /> Transform
          </button>
          <button role="menuitem" onClick={() => { onRetry(menu.node); setMenu(null); }}>
            <ArrowArcLeft size={15} /> Retry
          </button>
          <button role="menuitem" className="danger" onClick={() => { onDelete(menu.node); setMenu(null); }}>
            <Trash size={15} /> Delete
          </button>
        </div>
      )}
      {partMenu && (
        <div className="steps-menu part-menu" role="menu" style={{ left: partMenu.x, top: partMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {renderPartMenu(partMenu)}
        </div>
      )}
    </aside>
  );
});
