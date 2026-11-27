import { X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { pastedRecipe } from "../editor/recipe";
import type { LocalRecipe } from "../editor/types";
import { LOCAL_MODELS } from "../lib/ai";

/**
 * Edit → Use Settings From JSON: the user pastes the JSON that Copy JSON of
 * Inspect Layer made, here or in another document, and the prompt bar takes
 * those settings for the next local image.
 */
export function PasteSettingsDialog({ onUse, onClose }: { onUse: (recipe: LocalRecipe) => void; onClose: () => void }) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const use = () => {
    const result = pastedRecipe(json, LOCAL_MODELS);
    if ("error" in result) setError(result.error);
    else onUse(result.recipe);
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="save-dialog inspect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="paste-settings-title">Use Settings From JSON</h2>
          <button className="save-dialog-close" onClick={onClose} aria-label="Close" data-help="Close (Esc)">
            <X size={18} />
          </button>
        </header>
        <div className="inspect-body">
          <p className="inspect-note">
            Paste the JSON from Copy JSON in Inspect Layer. The next local image then uses its model files,
            LoRAs, prompts, seed and sampling settings in place of Settings → Local.
          </p>
          <textarea
            className="paste-settings-text"
            aria-label="Settings JSON"
            autoFocus
            spellCheck={false}
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              setError(null);
            }}
          />
          {error && <p className="paste-settings-error">{error}</p>}
        </div>
        <footer className="save-dialog-actions">
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!json.trim()} onClick={use}>Use Settings</button>
        </footer>
      </div>
    </div>
  );
}
