import { ImageSquare, MagicWand, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { validateGenerateSize } from "../editor/region";
import {
  IMAGE_MODELS,
  modelLabel,
  qualitiesFor,
  type AiSettings
} from "../lib/ai";
import { estimateOpenAiImage, formatUsd, usePrices } from "../lib/pricing";

/** What to generate; the new tab runs the request on its canvas. */
export interface NewImageRequest {
  prompt: string;
  model: string;
  quality: string;
  size: string;
}

interface Props {
  settings: AiSettings;
  connected: boolean;
  onRequestConnect: () => void;
  /** Saves the chosen model as the default for new images. */
  onSettingsChange: (settings: AiSettings) => void;
  onCancel: () => void;
  onStart: (request: NewImageRequest) => void;
}

const PRESETS = [
  { label: "Square", size: "1024x1024" },
  { label: "Landscape", size: "1536x1024" },
  { label: "Portrait", size: "1024x1536" },
  { label: "Large square", size: "2048x2048" },
  { label: "Wide 16:9", size: "2560x1440" },
  { label: "Tall 9:16", size: "1440x2560" }
];
const PROMPT_KEY = "imagesage.new-image-prompt";
const SIZE_KEY = "imagesage.new-image-size";

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function NewImageDialog({ settings, connected, onRequestConnect, onSettingsChange, onCancel, onStart }: Props) {
  usePrices();
  const [prompt, setPrompt] = useState(() => readStored(PROMPT_KEY) ?? "");
  const [size, setSize] = useState(() => readStored(SIZE_KEY) ?? "1536x1024");
  const [customWidth, setCustomWidth] = useState(() => size.split("x")[0]);
  const [customHeight, setCustomHeight] = useState(() => size.split("x")[1]);
  const [model, setModel] = useState(settings.generateModel);
  const [quality, setQuality] = useState(settings.quality);
  const custom = !PRESETS.some((preset) => preset.size === size);
  const effectiveSize = custom ? `${customWidth}x${customHeight}` : size;
  const [width, height] = effectiveSize.split("x").map(Number);
  const sizeError = validateGenerateSize(width, height);
  const qualities = qualitiesFor(model);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const generate = () => {
    if (!prompt.trim() || sizeError) return;
    if (!connected) {
      onRequestConnect();
      return;
    }
    try {
      localStorage.setItem(PROMPT_KEY, prompt);
      localStorage.setItem(SIZE_KEY, effectiveSize);
    } catch {
      /* Remembering the last prompt is a convenience only. */
    }
    onStart({ prompt: prompt.trim(), model, quality: qualities.includes(quality) ? quality : "auto", size: effectiveSize });
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div
        className="save-dialog new-image-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-image-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon"><ImageSquare size={22} weight="duotone" /></div>
          <div>
            <h2 id="new-image-title">New image from prompt</h2>
            <p>{modelLabel(model)} creates the image in a new tab.</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>

        <div className="save-dialog-body new-image-body">
          <section className="save-dialog-section new-image-form">
            <label className="form-row">
              <span className="form-row-label">Model</span>
              <select
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  onSettingsChange({ ...settings, generateModel: event.target.value });
                }}
              >
                {IMAGE_MODELS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label} · {option.note}</option>
                ))}
              </select>
            </label>
            <label className="form-row">
              <span className="form-row-label">Quality</span>
              <select value={qualities.includes(quality) ? quality : "auto"} onChange={(event) => setQuality(event.target.value)}>
                {qualities.map((option) => (
                  <option key={option} value={option}>
                    {option} · ~ {formatUsd(estimateOpenAiImage(model, option, effectiveSize))}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <label className="form-row-label" htmlFor="new-image-size">Size</label>
              <div className="form-row-control">
                <select id="new-image-size" value={custom ? "custom" : size} onChange={(event) => setSize(event.target.value === "custom" ? `${customWidth}x${customHeight}-custom` : event.target.value)}>
                  {PRESETS.map((preset) => (
                    <option key={preset.size} value={preset.size}>{preset.label} — {preset.size.replace("x", " × ")}</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {custom && (
                  <div className="form-row-size">
                    <span className="save-size-input-shell">
                      <input type="number" step={16} aria-label="Width" value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} />
                      <b>px</b>
                    </span>
                    <span aria-hidden="true">×</span>
                    <span className="save-size-input-shell">
                      <input type="number" step={16} aria-label="Height" value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} />
                      <b>px</b>
                    </span>
                  </div>
                )}
              </div>
            </div>
            <label className="form-row form-row-top">
              <span className="form-row-label">Prompt</span>
              <textarea
                className="settings-input new-image-prompt"
                autoFocus
                rows={6}
                value={prompt}
                placeholder="Describe the image you want…"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.ctrlKey && event.key === "Enter") {
                    event.preventDefault();
                    generate();
                  }
                }}
              />
            </label>
            {sizeError && <div className="settings-check error"><WarningCircle size={16} weight="fill" /><span>{sizeError}</span></div>}
          </section>
        </div>

        <footer className="save-dialog-actions">
          <button className="button secondary" onClick={onCancel}>Close</button>
          <button className="button primary" disabled={!prompt.trim() || Boolean(sizeError)} onClick={generate} data-help="Generate (Ctrl+Enter)">
            <MagicWand size={16} weight="bold" /> Generate
          </button>
        </footer>
      </div>
    </div>
  );
}
