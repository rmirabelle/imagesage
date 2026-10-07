import { CaretRight, X } from "@phosphor-icons/react";
import { Fragment, useEffect } from "react";

/**
 * One shortcut: its key combinations (each a list of keys pressed together;
 * several combinations are alternatives) and what it does.
 */
type Shortcut = { keys: string[][]; action: string };

const SECTIONS: { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: "General",
    shortcuts: [
      { keys: [["Ctrl", "Enter"]], action: "Generate a new layer" },
      { keys: [["Ctrl", "Shift", "Enter"]], action: "Regenerate the selected layer" },
      { keys: [["Ctrl", "S"]], action: "Save" },
      { keys: [["Ctrl", "Shift", "S"]], action: "Save As" }
    ]
  },
  {
    title: "Layers",
    shortcuts: [
      { keys: [["Ctrl", "T"]], action: "Transform the selected layer" },
      { keys: [["Ctrl", "J"]], action: "Duplicate the selected layer" },
      { keys: [["Del"]], action: "Delete the selected layer (asks first)" },
      { keys: [["Ctrl", "Click"]], action: "On a layer's eye: show only that layer, or show all again" }
    ]
  },
  {
    title: "Mask tool",
    shortcuts: [
      { keys: [["M"]], action: "Turn the Mask tool on or off; a layer without a mask gets one when you paint" },
      { keys: [["["], ["]"]], action: "Smaller / larger brush" },
      { keys: [["1–9"], ["0"]], action: "Brush opacity 10% to 90% / 100%" },
      { keys: [["+"], ["−"]], action: "Brush opacity up / down by 10% (number row)" },
      { keys: [["X"]], action: "Swap the brush between Show and Hide" },
      { keys: [["Alt"]], action: "Hold to paint the other of Show and Hide" },
      { keys: [["R"]], action: "Show or hide the red mask view" },
      { keys: [["P"]], action: "Switch the mask brush between soft and precise" },
      { keys: [["L"]], action: "Turn the polygon lasso on or off; Enter fills the shape, Backspace removes a corner" },
      { keys: [["Ctrl", "I"]], action: "Invert the mask" },
      { keys: [["Ctrl", "Z"]], action: "Undo a mask change" },
      { keys: [["Ctrl", "Y"], ["Ctrl", "R"]], action: "Redo a mask change" },
      { keys: [["Esc"]], action: "Turn off the Mask tool" }
    ]
  },
  {
    title: "Click to select",
    shortcuts: [
      { keys: [["Alt", "Click"]], action: "Remove the area under the pointer" },
      { keys: [["Ctrl", "Z"]], action: "Undo the last click" },
      { keys: [["Enter"]], action: "Apply" },
      { keys: [["Esc"]], action: "Cancel" }
    ]
  },
  {
    title: "Transform",
    shortcuts: [
      { keys: [["Shift"]], action: "Hold while you rotate to turn in 15° steps" },
      { keys: [["Enter"]], action: "Apply" },
      { keys: [["Esc"]], action: "Cancel" }
    ]
  },
  {
    title: "View",
    shortcuts: [
      { keys: [["Space", "Drag"]], action: "Pan" },
      { keys: [["Ctrl", "Wheel"]], action: "Zoom around the pointer" },
      { keys: [["Space", "Ctrl", "Click"]], action: "Zoom in" },
      { keys: [["Space", "Ctrl", "Alt", "Click"]], action: "Zoom out" }
    ]
  }
];

/** The keyboard shortcuts, in groups that open and close, from the Help menu. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="save-dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button className="save-dialog-close" onClick={onClose} aria-label="Close" data-help="Close (Esc)">
            <X size={18} />
          </button>
        </header>
        <div className="shortcuts-body">
          {SECTIONS.map((section) => (
            <details key={section.title} open>
              <summary><CaretRight size={12} weight="bold" /> {section.title}</summary>
              <dl>
                {section.shortcuts.map((shortcut) => (
                  <Fragment key={`${section.title}-${shortcut.action}`}>
                    <dt>
                      {shortcut.keys.map((combo, index) => (
                        <Fragment key={index}>
                          {index > 0 && <span className="shortcuts-or">/</span>}
                          {combo.map((key, at) => (
                            <Fragment key={at}>
                              {at > 0 && <span className="shortcuts-plus">+</span>}
                              <kbd>{key}</kbd>
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                    </dt>
                    <dd>{shortcut.action}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>
          ))}
        </div>
        <footer className="save-dialog-actions">
          <button className="button primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
