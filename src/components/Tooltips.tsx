import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Wait before a tooltip shows; a little longer than usual, so tooltips do not get in the way. Every tooltip waits the full time. */
const SHOW_DELAY = 1400;
const GAP = 8;
const EDGE = 8;

/**
 * `side` "left" places the tooltip left of its element; it comes from the
 * nearest `data-help-side`. `oneLine` (from `data-help-one-line`) keeps the
 * text on one line instead of one line per sentence.
 */
type Tip = { text: string; anchor: DOMRect; side: "left" | "below"; oneLine: boolean };

/** A line that ends in a short key name in parentheses, such as "Smaller brush ([)", shows the key as a key cap. */
const KEY_AT_END = /^(.*?)\s*\(([^()]{1,16})\)\s*$/;

/**
 * The lines of a tooltip: each sentence, and each part after a semicolon,
 * goes on its own line, so every instruction reads on its own. A semicolon
 * becomes the end of a sentence: the part before it gets a period, and the
 * part after it starts with a capital letter.
 */
const tipLines = (text: string) => text
  .split(/\n+/)
  .map((line) => line.replace(/;\s+(\S)/g, (_, first: string) => `. ${first.toUpperCase()}`))
  .flatMap((line) => line.split(/(?<=\.)\s+(?=[A-Z0-9])/))
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line[0].toUpperCase() + line.slice(1));

function TipText({ text, oneLine }: { text: string; oneLine: boolean }) {
  return (
    <>
      {(oneLine ? [text] : tipLines(text)).map((line, index) => {
        const match = KEY_AT_END.exec(line);
        return (
          <p key={index}>
            {match ? <>{match[1]} <kbd>{match[2]}</kbd></> : line}
          </p>
        );
      })}
    </>
  );
}

/**
 * Tooltips for every element with a `data-help` text. The element is found
 * from the pointer position, so disabled buttons show their tooltips too. A
 * press, a key, the wheel, or leaving the window hides the tooltip.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer = 0;
    let frame = 0;
    /** After a press, the element under the pointer shows no tooltip until the pointer moves to another one. */
    let suppressed: HTMLElement | null = null;
    let point: { x: number; y: number } | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      setTip(null);
    };
    const show = () => {
      const text = target?.isConnected ? target.dataset.help : undefined;
      if (!target || !text) return;
      const side = target.closest<HTMLElement>("[data-help-side]")?.dataset.helpSide === "left" ? "left" : "below";
      setTip({ text, anchor: target.getBoundingClientRect(), side, oneLine: target.dataset.helpOneLine !== undefined });
    };
    const update = () => {
      frame = 0;
      const element = point ? document.elementFromPoint(point.x, point.y) : null;
      const next = element?.closest<HTMLElement>("[data-help]") ?? null;
      if (next === target) return;
      hide();
      target = next;
      if (suppressed && next !== suppressed) suppressed = null;
      if (!next || next === suppressed) return;
      timer = window.setTimeout(show, SHOW_DELAY);
    };
    const onMove = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onPress = () => {
      suppressed = target;
      hide();
    };
    const onLeave = () => {
      point = null;
      target = null;
      hide();
    };
    const onOut = (event: PointerEvent) => { if (!event.relatedTarget) onLeave(); };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", onPress, true);
    window.addEventListener("wheel", onPress, { capture: true, passive: true });
    window.addEventListener("blur", onLeave);
    document.addEventListener("pointerout", onOut);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", onPress, true);
      window.removeEventListener("wheel", onPress, true);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("pointerout", onOut);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  /**
   * The tooltip sits below its element, or above it when there is no room
   * below, and stays inside the window. With side "left" it sits left of its
   * element, centered on it, when there is room there.
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!tip || !box) {
      setPosition(null);
      return;
    }
    const { width, height } = box.getBoundingClientRect();
    const { anchor } = tip;
    if (tip.side === "left" && anchor.left - GAP - width >= EDGE) {
      const middle = anchor.top + anchor.height / 2 - height / 2;
      setPosition({ left: anchor.left - GAP - width, top: Math.min(Math.max(EDGE, middle), window.innerHeight - EDGE - height) });
      return;
    }
    const below = anchor.bottom + GAP;
    const top = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - EDGE - width);
    setPosition({ left, top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      className={`tooltip ${position ? "shown" : ""}`}
      role="tooltip"
      style={position ?? { left: 0, top: 0 }}
    >
      <TipText text={tip.text} oneLine={tip.oneLine} />
    </div>
  );
}
