import { createContext, useContext, useState, type ReactNode } from "react";

/** Each help picture has two picture pixels for each CSS pixel; see `SHOT_SCALE` in capture.ts. */
const PICTURE_SCALE = 2;

/** Changes after new pictures are made, so the window loads them again. */
export const ShotVersion = createContext(0);

/**
 * One picture of the app, from `public/help/<name>.png`. The capture run
 * makes the file; see shots.ts.
 *
 * `side` puts the picture in the text: "right" and "left" let the text flow
 * around it, "inline" puts a small picture (one button) in a sentence, and
 * "block" gives it its own row, for a picture too wide to flow around.
 */
export function Shot({ name, alt, side = "right", caption }: { name: string; alt: string; side?: "right" | "left" | "inline" | "block"; caption?: string }) {
  const version = useContext(ShotVersion);
  const [width, setWidth] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);

  /** A picture that is not made yet shows its name in dev builds, and nothing in a released build. */
  if (missing) return import.meta.env.DEV ? <span className={`help-shot-missing ${side}`}>{name}</span> : null;

  const image = (
    <img
      key={version}
      src={`/help/${name}.png?v=${version}`}
      alt={alt}
      draggable={false}
      style={width === null ? { visibility: "hidden" } : side === "inline" ? undefined : { width }}
      onLoad={(event) => setWidth(event.currentTarget.naturalWidth / PICTURE_SCALE)}
      onError={() => setMissing(true)}
    />
  );
  if (side === "inline") return <span className="help-shot inline">{image}</span>;
  return (
    <figure className={`help-shot ${side}`}>
      {image}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Keys pressed together, for example `<Keys k="Ctrl+S" />`. */
export function Keys({ k }: { k: string }) {
  const keys = k.split("+");
  return (
    <span className="help-keys">
      {keys.map((key, index) => (
        <span key={index}>
          {index > 0 && <i>+</i>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  );
}

/** A menu path, for example `<MenuPath path="File > Settings" />`. */
export function MenuPath({ path }: { path: string }) {
  const parts = path.split(">").map((part) => part.trim());
  return (
    <span className="help-menu-path">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <i>›</i>}
          <b>{part}</b>
        </span>
      ))}
    </span>
  );
}

/** A short note set apart from the text. */
export function Tip({ children }: { children: ReactNode }) {
  return <aside className="help-tip">{children}</aside>;
}

/** A list of shortcuts: each row has the keys, then what they do. */
export function ShortcutList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="help-shortcuts">
      {rows.map(([keys, action]) => (
        <div key={keys}>
          <dt>{keys.split(" / ").map((combo, index) => <span key={combo}>{index > 0 && <i>/</i>}<Keys k={combo} /></span>)}</dt>
          <dd>{action}</dd>
        </div>
      ))}
    </dl>
  );
}
