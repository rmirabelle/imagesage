import { FilmStrip, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { SlideshowIntro } from "../lib/slideshowVideo";

const AUTHOR_KEY = "imagesage.slideshow-author";
const LINKS_KEY = "imagesage.slideshow-links";
const INTRO_KEY = "imagesage.slideshow-intro";

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

interface Props {
  /** The default title: the image's name. */
  defaultTitle: string;
  onCancel: () => void;
  /** `intro` is null when the video has no intro card. */
  onExport: (intro: SlideshowIntro | null) => void;
}

/** Settings for the video slideshow: whether it opens with an intro card, and what the card says. */
export function SlideshowDialog({ defaultTitle, onCancel, onExport }: Props) {
  const [useIntro, setUseIntro] = useState(() => readStored(INTRO_KEY) !== "0");
  const [title, setTitle] = useState(defaultTitle);
  const [author, setAuthor] = useState(() => readStored(AUTHOR_KEY) ?? "");
  const [links, setLinks] = useState(() => readStored(LINKS_KEY) ?? "");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const submit = () => {
    /** The author, the links and the intro choice are remembered for the next video; the title belongs to this image. */
    try {
      localStorage.setItem(AUTHOR_KEY, author);
      localStorage.setItem(LINKS_KEY, links);
      localStorage.setItem(INTRO_KEY, useIntro ? "1" : "0");
    } catch {
      /* Remembering is a convenience only. */
    }
    onExport(useIntro ? { title, author, links } : null);
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div className="save-dialog slideshow-dialog" role="dialog" aria-modal="true" aria-labelledby="slideshow-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon"><FilmStrip size={22} weight="duotone" /></div>
          <div>
            <h2 id="slideshow-title">Export video slideshow</h2>
            <p>Shows the original image, then each visible layer with its name. MP4, up to 1080p.</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>
        <div className="save-dialog-body slideshow-body">
          <label className="form-row">
            <span className="form-row-label">Intro</span>
            <span className="slideshow-check">
              <input type="checkbox" checked={useIntro} onChange={(event) => setUseIntro(event.target.checked)} />
              Open with a title card, then the finished image
            </span>
          </label>
          <label className="form-row">
            <span className="form-row-label">Title</span>
            <input className="settings-input" value={title} disabled={!useIntro} onChange={(event) => setTitle(event.target.value)} spellCheck={false} />
          </label>
          <label className="form-row">
            <span className="form-row-label">Author</span>
            <input className="settings-input" value={author} disabled={!useIntro} onChange={(event) => setAuthor(event.target.value)} spellCheck={false} />
          </label>
          <label className="form-row form-row-top">
            <span className="form-row-label">Links</span>
            <textarea className="settings-input slideshow-links" value={links} disabled={!useIntro} onChange={(event) => setLinks(event.target.value)} placeholder="One link per line" spellCheck={false} rows={3} />
          </label>
          <p className="slideshow-note">The title card also says "Made with ImageSage" with the app icon.</p>
        </div>
        <footer className="save-dialog-actions">
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button className="button primary" onClick={submit}>
            <FilmStrip size={16} weight="bold" /> Make video
          </button>
        </footer>
      </div>
    </div>
  );
}
