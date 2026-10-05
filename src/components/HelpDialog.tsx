import { useEffect } from "react";
import { HELP, type HelpTopic } from "../lib/help";

/** A help page for one topic, opened from a notice's "More info" link. */
export function HelpDialog({ topic, onClose }: { topic: HelpTopic; onClose: () => void }) {
  const help = HELP[topic];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="about-dialog-overlay" role="presentation" onPointerDown={onClose}>
      <div className="about-dialog help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title" onPointerDown={(event) => event.stopPropagation()}>
        <div className="model-dialog-body">
          <h2 id="help-dialog-title">{help.title}</h2>
          <p>{help.intro}</p>
          {help.sections.map((section) => (
            <section key={section.heading}>
              <h3>{section.heading}</h3>
              <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
          ))}
        </div>
        <footer className="about-dialog-actions">
          <button className="button secondary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
