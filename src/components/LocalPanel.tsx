import { CheckCircle, Cpu, FolderOpen, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import {
  CANCELLED_MESSAGE,
  LOCAL_MODELS,
  cancelAiRequest,
  downloadLocalEngine,
  findLocalModels,
  loadLocalModel,
  localModelReady,
  localStatus,
  saveLocalConfig,
  type LocalConfig,
  type LocalModelConfig,
  type LocalStatus
} from "../lib/ai";

type CheckState =
  | { kind: "idle" }
  | { kind: "working"; label: string; requestId?: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type FileKey = "diffusionModel" | "textEncoder" | "vae";

const FILE_LABELS: { key: FileKey; label: string }[] = [
  { key: "diffusionModel", label: "Diffusion model" },
  { key: "textEncoder", label: "Text encoder" },
  { key: "vae", label: "VAE" }
];

/** Each local model: its short name, example file names, and the scheduler its makers use. */
const MODEL_INFO: Record<string, { name: string; files: Record<FileKey, string>; scheduler: string }> = {
  "chroma1-hd": {
    name: "Chroma1-HD",
    files: { diffusionModel: "Chroma1-HD.safetensors", textEncoder: "t5xxl_fp16.safetensors", vae: "ae.safetensors" },
    scheduler: "beta"
  },
  "qwen-image-2.1": {
    name: "Qwen-Image-2.1",
    files: { diffusionModel: "NoctQ_V4_int8_convrot.safetensors", textEncoder: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" },
    scheduler: "simple"
  }
};

const EMPTY_FILES: LocalModelConfig = { diffusionModel: "", textEncoder: "", vae: "", negativePrompt: "", sampler: "euler", scheduler: "beta" };
const EMPTY_CONFIG: LocalConfig = { idleMinutes: 10, models: {} };

/** The engine's sampler names to compare; the two-pass ones take about twice as long per step. */
const SAMPLERS: { id: string; label: string }[] = [
  { id: "euler", label: "Euler" },
  { id: "dpm++2m", label: "DPM++ 2M" },
  { id: "res_multistep", label: "Res multistep" },
  { id: "euler_a", label: "Euler ancestral" },
  { id: "res_2s", label: "Res 2S (slower)" },
  { id: "heun", label: "Heun (slower)" }
];
/** The engine's scheduler names; the selected model's own is marked as recommended. */
const SCHEDULERS: { id: string; label: string }[] = [
  { id: "beta", label: "Beta" },
  { id: "simple", label: "Simple" },
  { id: "karras", label: "Karras" },
  { id: "sgm_uniform", label: "SGM uniform" },
  { id: "exponential", label: "Exponential" }
];
const MODEL_FILTERS = [{ name: "Model files", extensions: ["safetensors", "gguf", "sft"] }];

const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Settings for the optional local engine: its download, each local model's files and settings, and a load test. */
export function LocalPanel({
  status,
  onStatusChange,
  onWorkingChange
}: {
  status: LocalStatus | null;
  onStatusChange: (status: LocalStatus) => void;
  onWorkingChange: (working: boolean) => void;
}) {
  const [config, setConfig] = useState<LocalConfig>(status?.config ?? EMPTY_CONFIG);
  const [model, setModel] = useState(LOCAL_MODELS[0].id);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const working = check.kind === "working";
  const saved = useRef(JSON.stringify(status?.config ?? EMPTY_CONFIG));
  const info = MODEL_INFO[model];
  const files = config.models[model] ?? EMPTY_FILES;

  useEffect(() => {
    if (status) return;
    localStatus().then((loaded) => {
      onStatusChange(loaded);
      setConfig(loaded.config);
      saved.current = JSON.stringify(loaded.config);
    }).catch(() => {});
  }, [status, onStatusChange]);

  const save = async (next: LocalConfig) => {
    setConfig(next);
    const text = JSON.stringify(next);
    if (text === saved.current) return;
    saved.current = text;
    try {
      await saveLocalConfig(next);
      onStatusChange(await localStatus());
    } catch (error) {
      setCheck({ kind: "error", message: String(error) });
    }
  };

  /** The config with the selected model's files and settings changed. */
  const withFiles = (patch: Partial<LocalModelConfig>): LocalConfig => ({ ...config, models: { ...config.models, [model]: { ...files, ...patch } } });

  const run = async (label: string, action: (requestId: string, onPercent: (percent: number | null) => void) => Promise<string>) => {
    const requestId = crypto.randomUUID();
    setCheck({ kind: "working", label, requestId });
    onWorkingChange(true);
    const onPercent = (percent: number | null) =>
      setCheck((current) => current.kind === "working" ? { ...current, label: percent === null ? label : `${label} ${percent}%` } : current);
    try {
      setCheck({ kind: "success", message: await action(requestId, onPercent) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCheck(message === CANCELLED_MESSAGE ? { kind: "idle" } : { kind: "error", message });
    } finally {
      onWorkingChange(false);
      localStatus().then(onStatusChange).catch(() => {});
    }
  };

  const download = () => run("Downloading the engine…", async (requestId, onPercent) => {
    await downloadLocalEngine(requestId, (progress) => {
      if (progress.stage === "preparing") setCheck((current) => current.kind === "working" ? { ...current, label: "Unpacking the engine…" } : current);
      else onPercent(progress.progress === null ? null : Math.round(progress.progress * 100));
    });
    return "The engine is installed.";
  });

  const load = () => run(`Loading ${info.name}…`, (requestId) => loadLocalModel(requestId, model, () => {}));

  const browse = async (key: FileKey) => {
    const picked = await open({ multiple: false, directory: false, filters: MODEL_FILTERS, defaultPath: files[key] || undefined });
    if (typeof picked === "string") await save(withFiles({ [key]: picked }));
  };

  const findInFolder = async () => {
    const folder = await open({ multiple: false, directory: true, title: "Choose the ComfyUI folder or its models folder" });
    if (typeof folder !== "string") return;
    const found = await findLocalModels(folder, model);
    const next = withFiles({
      diffusionModel: found.diffusionModel ?? files.diffusionModel,
      textEncoder: found.textEncoder ?? files.textEncoder,
      vae: found.vae ?? files.vae
    });
    const count = [found.diffusionModel, found.textEncoder, found.vae].filter(Boolean).length;
    setCheck(count === 3
      ? { kind: "success", message: "Found all three model files." }
      : { kind: "error", message: count ? `Found ${count} of the 3 model files. Choose the others with Browse.` : `Found no ${info.name} model files in that folder.` });
    await save(next);
  };

  const installed = Boolean(status?.engineInstalled);
  const missing = status?.missing[model] ?? [];
  const runningName = status?.running ? MODEL_INFO[status.running]?.name : undefined;

  return (
    <>
      <div className="settings-pane-intro">
        <h3><Cpu size={22} /> Local</h3>
        <p>
          Local models make images on this computer, free and offline. Chroma1-HD makes new images from a prompt.
          Qwen-Image-2.1, or a merge of it such as Noct Q, also edits: Regenerate edits the selected layer into a new layer. They
          need an NVIDIA graphics card (24 GB or more of graphics memory works best) and the model's files, for example
          from ComfyUI.
        </p>
      </div>

      <div className="settings-group local-files">
        <div className="settings-group-title">Engine</div>
        <div className="settings-key-status">
          <i className={installed ? "connected" : ""} aria-hidden="true" />
          <span>
            {installed ? "Installed" : "Not installed"} · stable-diffusion.cpp{runningName ? ` · ${runningName} loaded` : ""}
          </span>
          {!installed && (
            <div className="settings-key-actions">
              <button className="button primary" disabled={working} onClick={() => void download()}>
                Download ({formatGb(status?.engineSizeBytes ?? 0)})
              </button>
            </div>
          )}
        </div>
        <small className="settings-help">The engine downloads once from the stable-diffusion.cpp project on GitHub and is checked before use.</small>
        <div className="form-row">
          <label className="form-row-label" htmlFor="local-idle">Free memory after</label>
          <div className="local-idle">
            <input
              id="local-idle"
              className="settings-input"
              type="number"
              min={1}
              max={240}
              value={config.idleMinutes}
              onChange={(event) => setConfig({ ...config, idleMinutes: Math.max(1, Math.min(240, Math.round(Number(event.target.value) || 1))) })}
              onBlur={() => void save(config)}
            />
            <span>minutes without a new image</span>
          </div>
        </div>
      </div>

      <div className="settings-group local-files">
        <div className="settings-group-title">Model files</div>
        <div className="form-row">
          <label className="form-row-label" htmlFor="local-model">Model</label>
          <select id="local-model" value={model} disabled={working} onChange={(event) => { setModel(event.target.value); setCheck({ kind: "idle" }); }}>
            {LOCAL_MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {MODEL_INFO[item.id]?.name ?? item.label}{localModelReady(status, item.id) ? "" : " (files not set)"}
              </option>
            ))}
          </select>
        </div>
        {FILE_LABELS.map(({ key, label }) => (
          <div key={key} className="form-row">
            <label className="form-row-label" htmlFor={`local-${key}`}>{label}</label>
            <div className="settings-key-row">
              <input
                id={`local-${key}`}
                className="settings-input"
                spellCheck={false}
                placeholder={info.files[key]}
                value={files[key]}
                onChange={(event) => setConfig(withFiles({ [key]: event.target.value }))}
                onBlur={() => void save(config)}
              />
              <button className="button secondary" disabled={working} onClick={() => void browse(key)}>Browse…</button>
            </div>
          </div>
        ))}
        <div className="form-row">
          <span className="form-row-label" />
          <div>
            <button className="button secondary" disabled={working} onClick={() => void findInFolder()}>
              <FolderOpen size={16} /> Find in ComfyUI folder…
            </button>
          </div>
        </div>
        {missing.length > 0 && files.diffusionModel + files.textEncoder + files.vae !== "" && (
          <div className="settings-check error" role="status">
            <WarningCircle size={16} weight="fill" />
            <span>Not found: {missing.join(", ")}.</span>
          </div>
        )}
      </div>

      <div className="settings-group local-files">
        <div className="settings-group-title">Image settings ({info.name})</div>
        <div className="form-row">
          <label className="form-row-label" htmlFor="local-sampler">Sampler</label>
          <select id="local-sampler" value={files.sampler} onChange={(event) => void save(withFiles({ sampler: event.target.value }))}>
            {!SAMPLERS.some(({ id }) => id === files.sampler) && <option value={files.sampler}>{files.sampler}</option>}
            {SAMPLERS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label className="form-row-label" htmlFor="local-scheduler">Scheduler</label>
          <select id="local-scheduler" value={files.scheduler} onChange={(event) => void save(withFiles({ scheduler: event.target.value }))}>
            {!SCHEDULERS.some(({ id }) => id === files.scheduler) && <option value={files.scheduler}>{files.scheduler}</option>}
            {SCHEDULERS.map(({ id, label }) => <option key={id} value={id}>{id === info.scheduler ? `${label} (recommended)` : label}</option>)}
          </select>
        </div>
        <div className="form-row form-row-top">
          <label className="form-row-label" htmlFor="local-negative">Negative prompt</label>
          <div className="local-negative">
            <textarea
              id="local-negative"
              className="settings-input"
              spellCheck={false}
              placeholder="What every image avoids"
              value={files.negativePrompt}
              onChange={(event) => setConfig(withFiles({ negativePrompt: event.target.value }))}
              onBlur={() => void save(config)}
            />
            {status && files.negativePrompt !== status.defaultNegativePrompt && (
              <button className="settings-link" onClick={() => void save(withFiles({ negativePrompt: status.defaultNegativePrompt }))}>Use the default</button>
            )}
          </div>
        </div>
        <small className="settings-help">The negative prompt lists what {info.name} should avoid in every image, such as blur and extra fingers. The settings apply to the next image.</small>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">Check</div>
        <div>
          <button className="button secondary" disabled={working || !installed || missing.length > 0} onClick={() => void load()}>
            Load {info.name}
          </button>
        </div>
        <small className="settings-help">Loads the model into the graphics memory, which takes up to a minute. The first image also loads it. Only one local model is loaded at a time.</small>
        {check.kind !== "idle" && (
          <div className={`settings-check ${check.kind}`} role="status">
            {check.kind === "working" && <SpinnerGap className="spin" size={16} />}
            {check.kind === "success" && <CheckCircle size={16} weight="fill" />}
            {check.kind === "error" && <WarningCircle size={16} weight="fill" />}
            <span>{check.kind === "working" ? check.label : check.message}</span>
            {check.kind === "working" && check.requestId && (
              <button className="settings-link" onClick={() => void cancelAiRequest(check.requestId!)}>Cancel</button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
