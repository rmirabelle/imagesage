import { CaretRight, CheckCircle, Info, PencilSimple, SpinnerGap, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { FluxLogo, OpenAiMark } from "./BrandLogos";
import { useEffect, useState, type ReactNode } from "react";
import { FLUX_RESOLUTIONS, type FluxResolution } from "../editor/region";
import {
  DEFAULT_AI_SETTINGS,
  EDIT_MODEL_ID,
  IMAGE_MODELS,
  clearApiKey,
  qualitiesFor,
  saveApiKey,
  testApiKey,
  type AiSettings,
  type ApiKeyStatus,
  type KeyStatuses,
  type Provider
} from "../lib/ai";
import { estimateOpenAiImage, fluxPrice, formatUsd, priceSourceNote, usePrices } from "../lib/pricing";

export type SettingsSection = "new" | "edits";

interface Props {
  statuses: KeyStatuses;
  settings: AiSettings;
  initialSection: SettingsSection;
  onStatusChange: (provider: Provider, status: ApiKeyStatus) => void;
  onSettingsChange: (settings: AiSettings) => void;
  onClose: () => void;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

const SECTIONS: Record<SettingsSection, { label: string; role: string; service: string; provider: Provider; description: string; keyHelp: string; placeholder: string }> = {
  new: {
    label: "OpenAI",
    role: "New images",
    service: "OpenAI",
    provider: "openai",
    description: "OpenAI creates new images from a prompt and edits whole images. Each image is paid from your API credits.",
    keyHelp: "Create a key at platform.openai.com → API keys, with Images set to Request and List models set to Read.",
    placeholder: "sk-…"
  },
  edits: {
    label: "FLUX 3",
    role: "Image edits",
    service: "FLUX 3",
    provider: "flux",
    description: "FLUX 3 Image repaints the square you select. ImageSage keeps every pixel outside it.",
    keyHelp: "Create a key in the Black Forest Labs dashboard at api.bfl.ai.",
    placeholder: "Paste your FLUX API key"
  }
};

/** One labelled setting: the label and a short hint on the left, the control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function NumberInput({ value, unit, min, max, onChange }: { value: number; unit: string; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <span className="save-size-input-shell settings-number">
      <input
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Math.round(Number(event.target.value) || 0))))}
      />
      <b>{unit}</b>
    </span>
  );
}

function KeyPanel({
  section,
  status,
  model,
  onStatusChange,
  onWorkingChange
}: {
  section: SettingsSection;
  status: ApiKeyStatus;
  model: string;
  onStatusChange: (provider: Provider, status: ApiKeyStatus) => void;
  onWorkingChange: (working: boolean) => void;
}) {
  const copy = SECTIONS[section];
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(!status.connected);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const working = check.kind === "working";

  const run = async (label: string, action: () => Promise<string>) => {
    setCheck({ kind: "working", label });
    onWorkingChange(true);
    try {
      setCheck({ kind: "success", message: await action() });
    } catch (error) {
      setCheck({ kind: "error", message: String(error) });
    } finally {
      onWorkingChange(false);
    }
  };

  const save = () => run("Checking the key…", async () => {
    const message = await testApiKey(copy.provider, key.trim(), model);
    onStatusChange(copy.provider, await saveApiKey(copy.provider, key.trim()));
    setKey("");
    setEditing(false);
    return message;
  });

  const test = () => run("Checking the key…", () => testApiKey(copy.provider, null, model));

  const remove = () => run("Removing the key…", async () => {
    await clearApiKey(copy.provider);
    onStatusChange(copy.provider, { connected: false, hint: null });
    setEditing(true);
    return "The key was removed from this computer.";
  });

  return (
    <div className="settings-group">
      <div className="settings-group-title">{copy.service} API key</div>
      {status.connected && !editing ? (
        <div className="settings-key-status">
          <i className="connected" aria-hidden="true" />
          <span>Connected · <code>{status.hint}</code></span>
          <div className="settings-key-actions">
            <button className="button secondary" disabled={working} onClick={() => void test()}>Test</button>
            <button className="button secondary icon-button" disabled={working} onClick={() => setEditing(true)} data-help="Replace key" aria-label="Replace key">
              <PencilSimple size={16} />
            </button>
            <button className="button secondary icon-button" disabled={working} onClick={() => void remove()} data-help="Remove key" aria-label="Remove key">
              <Trash size={16} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="settings-key-row">
            <input
              className="settings-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-label={`${copy.service} API key`}
              placeholder={copy.placeholder}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && key.trim()) void save();
              }}
            />
            {status.connected && (
              <button className="button secondary" disabled={working} onClick={() => { setEditing(false); setKey(""); }}>Cancel</button>
            )}
            <button className="button primary" disabled={working || !key.trim()} onClick={() => void save()}>Save key</button>
          </div>
          <small className="settings-help">{copy.keyHelp} The key is stored in Windows Credential Manager.</small>
        </>
      )}
      {check.kind !== "idle" && (
        <div className={`settings-check ${check.kind}`} role="status">
          {check.kind === "working" && <SpinnerGap className="spin" size={16} />}
          {check.kind === "success" && <CheckCircle size={16} weight="fill" />}
          {check.kind === "error" && <WarningCircle size={16} weight="fill" />}
          <span>{check.kind === "working" ? check.label : check.message}</span>
        </div>
      )}
    </div>
  );
}

export function ConnectDialog({ statuses, settings, initialSection, onStatusChange, onSettingsChange, onClose }: Props) {
  usePrices();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState<AiSettings>(settings);
  const [fineTuning, setFineTuning] = useState(false);
  const [workingCount, setWorkingCount] = useState(0);
  const working = workingCount > 0;
  const onWorkingChange = (next: boolean) => setWorkingCount((count) => Math.max(0, count + (next ? 1 : -1)));
  const update = (patch: Partial<AiSettings>) => setDraft((current) => ({ ...current, ...patch }));
  const copy = SECTIONS[section];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, working]);

  const resetSection = () => update(section === "new"
    ? {
      generateModel: DEFAULT_AI_SETTINGS.generateModel,
      quality: DEFAULT_AI_SETTINGS.quality,
      wholeModel: DEFAULT_AI_SETTINGS.wholeModel,
      wholeQuality: DEFAULT_AI_SETTINGS.wholeQuality
    }
    : {
      maxResolution: DEFAULT_AI_SETTINGS.maxResolution,
      marginRatio: DEFAULT_AI_SETTINGS.marginRatio,
      minMargin: DEFAULT_AI_SETTINGS.minMargin,
      feather: DEFAULT_AI_SETTINGS.feather,
      driftCorrection: DEFAULT_AI_SETTINGS.driftCorrection
    });

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={() => !working && onClose()}>
      <div
        className="save-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="ai-settings-title">Settings</h2>
          <button className="save-dialog-close" onClick={onClose} disabled={working} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {(Object.keys(SECTIONS) as SettingsSection[]).map((id) => {
              const item = SECTIONS[id];
              const connected = statuses[item.provider].connected;
              return (
                <button
                  key={id}
                  className={section === id ? "active" : ""}
                  aria-current={section === id ? "page" : undefined}
                  onClick={() => setSection(id)}
                >
                  {id === "new" ? <OpenAiMark size={20} /> : <FluxLogo size={20} />}
                  <span>
                    <strong>{item.label}</strong>
                    <small><i className={connected ? "connected" : ""} aria-hidden="true" /> {item.role}{connected ? "" : " · no key"}</small>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="settings-pane">
            <div className="settings-pane-intro">
              <h3>{section === "new" ? <OpenAiMark size={22} /> : <FluxLogo size={22} />} {copy.label}</h3>
              <p>{copy.description}</p>
              <div className="settings-price-note" role="note">
                <Info size={15} weight="fill" aria-hidden="true" />
                <span>{priceSourceNote()}</span>
              </div>
            </div>

            <KeyPanel
              key={section}
              section={section}
              status={statuses[copy.provider]}
              model={section === "new" ? draft.generateModel : EDIT_MODEL_ID}
              onStatusChange={onStatusChange}
              onWorkingChange={onWorkingChange}
            />

            {section === "new" ? (
              <>
              <div className="settings-group">
                <div className="settings-group-title">New images</div>
                <Row label="Model" hint="Prices are for one 1024 × 1024 image.">
                  <select value={draft.generateModel} onChange={(event) => update({ generateModel: event.target.value })}>
                    {IMAGE_MODELS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} · ~ {formatUsd(estimateOpenAiImage(model.id, qualitiesFor(model.id).includes(draft.quality) ? draft.quality : "high", "1024x1024"))}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Quality" hint="Higher costs more and takes longer.">
                  <select value={qualitiesFor(draft.generateModel).includes(draft.quality) ? draft.quality : "auto"} onChange={(event) => update({ quality: event.target.value })}>
                    {qualitiesFor(draft.generateModel).map((quality) => (
                      <option key={quality} value={quality}>{quality} · ~ {formatUsd(estimateOpenAiImage(draft.generateModel, quality, "1024x1024"))}</option>
                    ))}
                  </select>
                </Row>
              </div>
              <div className="settings-group">
                <div className="settings-group-title">Edits</div>
                <Row label="Model" hint="Used for whole-image edits, and for square and brush edits when GPT Image is chosen. Output price for 1024 × 1024.">
                  <select value={draft.wholeModel} onChange={(event) => update({ wholeModel: event.target.value })}>
                    {IMAGE_MODELS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} · ~ {formatUsd(estimateOpenAiImage(model.id, qualitiesFor(model.id).includes(draft.wholeQuality) ? draft.wholeQuality : "high", "1024x1024"))}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Quality" hint="Higher keeps more detail, costs more, and takes longer.">
                  <select value={qualitiesFor(draft.wholeModel).includes(draft.wholeQuality) ? draft.wholeQuality : "high"} onChange={(event) => update({ wholeQuality: event.target.value })}>
                    {qualitiesFor(draft.wholeModel).map((quality) => (
                      <option key={quality} value={quality}>{quality} · ~ {formatUsd(estimateOpenAiImage(draft.wholeModel, quality, "1024x1024"))}</option>
                    ))}
                  </select>
                </Row>
              </div>
              </>
            ) : (
              <div className="settings-group">
                <div className="settings-group-title">Options</div>
                <Row label="Largest output size" hint="Larger keeps more detail and costs more.">
                  <select value={draft.maxResolution} onChange={(event) => update({ maxResolution: event.target.value as FluxResolution })}>
                    {FLUX_RESOLUTIONS.map((resolution) => (
                      <option key={resolution.id} value={resolution.id}>
                        {resolution.id} · {resolution.edge} px · {fluxPrice(resolution.id).estimated ? "~ " : ""}{formatUsd(fluxPrice(resolution.id).usd)}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Context around selection" hint="How much of the nearby image FLUX sees.">
                  <NumberInput value={Math.round(draft.marginRatio * 100)} unit="%" min={0} max={50} onChange={(value) => update({ marginRatio: value / 100 })} />
                </Row>
                <button className={`settings-disclosure ${fineTuning ? "open" : ""}`} onClick={() => setFineTuning((open) => !open)} aria-expanded={fineTuning}>
                  <CaretRight size={13} weight="bold" /> Fine tuning
                </button>
                {fineTuning && (
                  <>
                    <Row label="Minimum context" hint="Used when the selection is small.">
                      <NumberInput value={draft.minMargin} unit="px" min={0} max={512} onChange={(value) => update({ minMargin: value })} />
                    </Row>
                    <Row label="Edge blend" hint="Soft blend just inside the selection edge.">
                      <NumberInput value={draft.feather} unit="px" min={0} max={64} onChange={(value) => update({ feather: value })} />
                    </Row>
                    <Row label="Color match" hint="Match the result's colors to the image around it.">
                      <label className="settings-switch">
                        <input type="checkbox" checked={draft.driftCorrection} onChange={(event) => update({ driftCorrection: event.target.checked })} />
                        <span>{draft.driftCorrection ? "On" : "Off"}</span>
                      </label>
                    </Row>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="save-dialog-actions">
          <button className="button secondary settings-reset" disabled={working} onClick={resetSection}>Reset {copy.label} options</button>
          <button className="button secondary" disabled={working} onClick={onClose}>Cancel</button>
          <button
            className="button primary"
            disabled={working}
            onClick={() => {
              onSettingsChange(draft);
              onClose();
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
