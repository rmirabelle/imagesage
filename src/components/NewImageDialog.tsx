import { ImageSquare, MagicWand, SpinnerGap, StopCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { validateGenerateSize } from "../editor/region";
import {
  CANCELLED_MESSAGE,
  canCancel,
  cancelAiRequest,
  generateImage,
  IMAGE_MODELS,
  modelLabel,
  qualitiesFor,
  stageLabel,
  type AiSettings,
  type AiStage
} from "../lib/ai";
import { estimateOpenAiImage, formatUsd, openAiActualCost, usePrices } from "../lib/pricing";

export interface GeneratedImage {
  dataUrl: string;
  prompt: string;
  model: string;
  quality: string;
  size: string;
  /** The charge in US dollars from OpenAI's usage report, or null when it was not reported. */
  cost: number | null;
}

interface Props {
  settings: AiSettings;
  connected: boolean;
  onRequestConnect: () => void;
  /** Saves the chosen model as the default for new images. */
  onSettingsChange: (settings: AiSettings) => void;
  onCancel: () => void;
  onGenerated: (image: GeneratedImage) => void;
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

export function NewImageDialog({ settings, connected, onRequestConnect, onSettingsChange, onCancel, onGenerated }: Props) {
  usePrices();
  const [prompt, setPrompt] = useState(() => readStored(PROMPT_KEY) ?? "");
  const [size, setSize] = useState(() => readStored(SIZE_KEY) ?? "1536x1024");
  const [customWidth, setCustomWidth] = useState(() => size.split("x")[0]);
  const [customHeight, setCustomHeight] = useState(() => size.split("x")[1]);
  const [model, setModel] = useState(settings.generateModel);
  const [quality, setQuality] = useState(settings.quality);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [stage, setStage] = useState<AiStage | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const custom = !PRESETS.some((preset) => preset.size === size);
  const effectiveSize = custom ? `${customWidth}x${customHeight}` : size;
  const [width, height] = effectiveSize.split("x").map(Number);
  const sizeError = validateGenerateSize(width, height);
  const busy = requestId !== null;
  const qualities = qualitiesFor(model);
  const estimate = sizeError ? null : estimateOpenAiImage(model, quality, effectiveSize, prompt.length);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const generate = async () => {
    if (!prompt.trim() || sizeError || busy) return;
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
    const id = crypto.randomUUID();
    setRequestId(id);
    setStage(null);
    setPartial(null);
    setError(null);
    try {
      const result = await generateImage(id, {
        prompt: prompt.trim(),
        model,
        quality,
        size: effectiveSize
      }, (progress) => {
        setStage(progress.stage);
        if (progress.partialDataUrl) setPartial(progress.partialDataUrl);
      });
      onGenerated({
        dataUrl: result.dataUrl,
        prompt: prompt.trim(),
        model,
        quality,
        size: effectiveSize,
        cost: openAiActualCost(result.usage, model)
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message !== CANCELLED_MESSAGE) setError(message);
    } finally {
      setRequestId(null);
    }
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={() => !busy && onCancel()}>
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
            <p>{modelLabel(model)} creates the image; it opens in a new tab.</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} disabled={busy} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>

        <div className="save-dialog-body new-image-body">
          <section className="save-dialog-section new-image-form">
            <label className="form-row">
              <span className="form-row-label">Model</span>
              <select
                value={model}
                disabled={busy}
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
              <select value={qualities.includes(quality) ? quality : "auto"} disabled={busy} onChange={(event) => setQuality(event.target.value)}>
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
                <select id="new-image-size" value={custom ? "custom" : size} disabled={busy} onChange={(event) => setSize(event.target.value === "custom" ? `${customWidth}x${customHeight}-custom` : event.target.value)}>
                  {PRESETS.map((preset) => (
                    <option key={preset.size} value={preset.size}>{preset.label} — {preset.size.replace("x", " × ")}</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {custom && (
                  <div className="form-row-size">
                    <span className="save-size-input-shell">
                      <input type="number" step={16} aria-label="Width" value={customWidth} disabled={busy} onChange={(event) => setCustomWidth(event.target.value)} />
                      <b>px</b>
                    </span>
                    <span aria-hidden="true">×</span>
                    <span className="save-size-input-shell">
                      <input type="number" step={16} aria-label="Height" value={customHeight} disabled={busy} onChange={(event) => setCustomHeight(event.target.value)} />
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
                disabled={busy}
                placeholder="Describe the image you want…"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.ctrlKey && event.key === "Enter") {
                    event.preventDefault();
                    void generate();
                  }
                }}
              />
            </label>
            {sizeError && <div className="settings-check error"><WarningCircle size={16} weight="fill" /><span>{sizeError}</span></div>}
          </section>
          {(busy || partial || error) && (
            <section className="new-image-preview">
              {partial ? <img src={partial} alt="Partial preview" /> : <div className="new-image-preview-empty" />}
              {busy && (
                <div className="new-image-status" role="status">
                  <SpinnerGap className="spin" size={18} /> {stageLabel(stage)}
                </div>
              )}
              {error && <div className="settings-check error"><WarningCircle size={16} weight="fill" /><span>{error}</span></div>}
            </section>
          )}
        </div>

        <footer className="save-dialog-actions">
          {busy ? (
            canCancel(stage) ? (
              <button className="button secondary" onClick={() => requestId && void cancelAiRequest(requestId)}>
                <StopCircle size={16} weight="bold" /> Cancel generation
              </button>
            ) : (
              <span className="dialog-status-note">OpenAI has the request and will finish it.</span>
            )
          ) : (
            <>
              <button className="button secondary" onClick={onCancel}>Close</button>
              <button className="button primary" disabled={!prompt.trim() || Boolean(sizeError)} onClick={() => void generate()} data-help="Generate (Ctrl+Enter)">
                <MagicWand size={16} weight="bold" /> Generate
                {estimate !== null && <span className="price-tag">about {formatUsd(estimate)}</span>}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
