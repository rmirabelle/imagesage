import { CheckCircle, Cpu, FolderOpen, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  CANCELLED_MESSAGE,
  LOCAL_SETTINGS_MODELS,
  cancelAiRequest,
  downloadLocalEngine,
  findLocalModels,
  isVideoModel,
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

/** Runs one task of a section (the engine, or one model) and shows its progress and result in that section. */
type RunTask = (owner: string, label: string, action: (requestId: string, onPercent: (percent: number | null) => void) => Promise<string>) => Promise<void>;

type LoraKey = "lora" | "highNoiseLora";
/** A LoRA row and its strength row. Wan 2.2 takes one LoRA for each of its two diffusion models. */
type LoraSlot = { key: LoraKey; strength: "loraStrength" | "highNoiseLoraStrength"; label: string; strengthLabel: string };
const IMAGE_LORAS: LoraSlot[] = [{ key: "lora", strength: "loraStrength", label: "LoRA", strengthLabel: "LoRA strength" }];
const VIDEO_LORAS: LoraSlot[] = [
  { key: "lora", strength: "loraStrength", label: "Low-noise LoRA", strengthLabel: "Strength" },
  { key: "highNoiseLora", strength: "highNoiseLoraStrength", label: "High-noise LoRA", strengthLabel: "Strength" }
];

type FileKey = "diffusionModel" | "highNoiseModel" | "textEncoder" | "vae";

const IMAGE_FILE_LABELS: { key: FileKey; label: string }[] = [
  { key: "diffusionModel", label: "Diffusion model" },
  { key: "textEncoder", label: "Text encoder" },
  { key: "vae", label: "VAE" }
];
/** Wan 2.2 has two diffusion models: the high-noise model starts a clip and the low-noise model finishes it. */
const VIDEO_FILE_LABELS: { key: FileKey; label: string }[] = [
  { key: "diffusionModel", label: "Low-noise model" },
  { key: "highNoiseModel", label: "High-noise model" },
  { key: "textEncoder", label: "Text encoder" },
  { key: "vae", label: "VAE" }
];

/** Each local model: its short name, what Image Sage uses it for, example file names, and the scheduler its makers use. */
const MODEL_INFO: Record<string, { name: string; use: string; files: Partial<Record<FileKey, string>>; scheduler: string }> = {
  "chroma1-hd": {
    name: "Chroma1-HD",
    use: "New images from a prompt",
    files: { diffusionModel: "Chroma1-HD.safetensors", textEncoder: "t5xxl_fp16.safetensors", vae: "ae.safetensors" },
    scheduler: "beta"
  },
  "qwen-image-2.1": {
    name: "Qwen-Image-2.1",
    use: "New images, and Regenerate edits of a layer",
    files: { diffusionModel: "NoctQ_V4_int8_convrot.safetensors", textEncoder: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" },
    scheduler: "simple"
  },
  "wan-2.2-i2v": {
    name: "Wan 2.2 image-to-video",
    use: "A video that starts from a layer's picture",
    files: {
      diffusionModel: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
      highNoiseModel: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
      textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      vae: "wan_2.1_vae.safetensors"
    },
    scheduler: "simple"
  },
  "wan-2.2-t2v": {
    name: "Wan 2.2 text-to-video",
    use: "A video from the prompt alone",
    files: {
      diffusionModel: "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
      highNoiseModel: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
      textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      vae: "wan_2.1_vae.safetensors"
    },
    scheduler: "simple"
  }
};

const EMPTY_FILES: LocalModelConfig = { diffusionModel: "", highNoiseModel: "", textEncoder: "", vae: "", negativePrompt: "", promptPrefix: "", sampler: "euler", scheduler: "beta", lora: "", loraStrength: 0.75, highNoiseLora: "", highNoiseLoraStrength: 1 };
const EMPTY_CONFIG: LocalConfig = { idleMinutes: 10, models: {} };
const IDLE: CheckState = { kind: "idle" };
/** The owner name of the engine's own tasks; the other owners are local model ids. */
const ENGINE = "engine";

/** The engine's sampler names to compare; the two-pass ones take about twice as long per step. */
const SAMPLERS: { id: string; label: string }[] = [
  { id: "euler", label: "Euler" },
  { id: "dpm++2m", label: "DPM++ 2M" },
  { id: "res_multistep", label: "Res multistep" },
  { id: "euler_a", label: "Euler ancestral" },
  { id: "res_2s", label: "Res 2S (slower)" },
  { id: "heun", label: "Heun (slower)" }
];
/** The engine's scheduler names; the model's own is marked as recommended. */
const SCHEDULERS: { id: string; label: string }[] = [
  { id: "beta", label: "Beta" },
  { id: "simple", label: "Simple" },
  { id: "karras", label: "Karras" },
  { id: "sgm_uniform", label: "SGM uniform" },
  { id: "exponential", label: "Exponential" }
];
const MODEL_FILTERS = [{ name: "Model files", extensions: ["safetensors", "gguf", "sft"] }];

const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The progress or the result of a section's task. */
function CheckLine({ check }: { check: CheckState }) {
  if (check.kind === "idle") return null;
  return (
    <div className={`settings-check ${check.kind}`} role="status">
      {check.kind === "working" && <SpinnerGap className="spin" size={16} />}
      {check.kind === "success" && <CheckCircle size={16} weight="fill" />}
      {check.kind === "error" && <WarningCircle size={16} weight="fill" />}
      <span>{check.kind === "working" ? check.label : check.message}</span>
      {check.kind === "working" && check.requestId && (
        <button className="settings-link" onClick={() => void cancelAiRequest(check.requestId!)}>Cancel</button>
      )}
    </div>
  );
}

/**
 * One local model's section: its files, its settings, and a load test.
 * `onPatch` changes the model's settings; with `commit` it also saves them.
 */
function ModelSection({
  model,
  files,
  status,
  check,
  busy,
  onPatch,
  onCommit,
  onMessage,
  run
}: {
  model: string;
  files: LocalModelConfig;
  status: LocalStatus | null;
  check: CheckState;
  /** A task runs in this or another section. */
  busy: boolean;
  onPatch: (patch: Partial<LocalModelConfig>, commit: boolean) => void;
  /** Saves what `onPatch` changed without `commit`. */
  onCommit: () => void;
  onMessage: (check: CheckState) => void;
  run: RunTask;
}) {
  const info = MODEL_INFO[model];
  const video = isVideoModel(model);
  const fileLabels = video ? VIDEO_FILE_LABELS : IMAGE_FILE_LABELS;
  const loraSlots = video ? VIDEO_LORAS : IMAGE_LORAS;
  const installed = Boolean(status?.engineInstalled);
  const missing = status?.missing[model] ?? [];
  const ready = localModelReady(status, model);
  const loaded = status?.running === model;
  const id = (name: string) => `local-${model}-${name}`;

  const browse = async (key: FileKey | LoraKey) => {
    const picked = await open({ multiple: false, directory: false, filters: MODEL_FILTERS, defaultPath: files[key] || undefined });
    if (typeof picked === "string") onPatch({ [key]: picked }, true);
  };

  const findInFolder = async () => {
    const folder = await open({ multiple: false, directory: true, title: "Choose the ComfyUI folder or its models folder" });
    if (typeof folder !== "string") return;
    const found = await findLocalModels(folder, model);
    const count = fileLabels.filter(({ key }) => found[key]).length;
    onMessage(count === fileLabels.length
      ? { kind: "success", message: `Found all ${count} model files.` }
      : { kind: "error", message: count ? `Found ${count} of the ${fileLabels.length} model files. Choose the others with Browse.` : `Found no ${info.name} model files in that folder.` });
    onPatch(Object.fromEntries(fileLabels.map(({ key }) => [key, found[key] ?? files[key]])), true);
  };

  const load = () => run(model, `Loading ${info.name}…`, (requestId) => loadLocalModel(requestId, model, () => {}));

  return (
    <div className="settings-group local-files">
      <div className="settings-group-title">{info.name}</div>
      <div className="settings-key-status">
        <i className={ready ? "connected" : ""} aria-hidden="true" />
        <span>{!installed ? "Engine not installed" : ready ? (loaded ? "Ready · loaded" : "Ready") : "Files not set"} · {info.use}</span>
      </div>
      {fileLabels.map(({ key, label }) => (
        <div key={key} className="form-row">
          <label className="form-row-label" htmlFor={id(key)}>{label}</label>
          <div className="settings-key-row">
            <input
              id={id(key)}
              className="settings-input"
              spellCheck={false}
              placeholder={info.files[key]}
              value={files[key]}
              onChange={(event) => onPatch({ [key]: event.target.value }, false)}
              onBlur={onCommit}
            />
            <button className="button secondary" disabled={busy} onClick={() => void browse(key)}>Browse…</button>
          </div>
        </div>
      ))}
      <div className="form-row">
        <span className="form-row-label" />
        <div className="local-model-actions">
          <button className="button secondary" disabled={busy} onClick={() => void findInFolder()}>
            <FolderOpen size={16} /> Find in ComfyUI folder…
          </button>
          <button className="button secondary" disabled={busy || !ready} onClick={() => void load()}>Load to check</button>
        </div>
      </div>
      {missing.length > 0 && files.diffusionModel + files.highNoiseModel + files.textEncoder + files.vae + files.lora + files.highNoiseLora !== "" && (
        <div className="settings-check error" role="status">
          <WarningCircle size={16} weight="fill" />
          <span>Not found: {missing.join(", ")}.</span>
        </div>
      )}
      <CheckLine check={check} />
      {!video && (<>
        <div className="form-row">
          <label className="form-row-label" htmlFor={id("sampler")}>Sampler</label>
          <select id={id("sampler")} value={files.sampler} onChange={(event) => onPatch({ sampler: event.target.value }, true)}>
            {!SAMPLERS.some((item) => item.id === files.sampler) && <option value={files.sampler}>{files.sampler}</option>}
            {SAMPLERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label className="form-row-label" htmlFor={id("scheduler")}>Scheduler</label>
          <select id={id("scheduler")} value={files.scheduler} onChange={(event) => onPatch({ scheduler: event.target.value }, true)}>
            {!SCHEDULERS.some((item) => item.id === files.scheduler) && <option value={files.scheduler}>{files.scheduler}</option>}
            {SCHEDULERS.map((item) => <option key={item.id} value={item.id}>{item.id === info.scheduler ? `${item.label} (recommended)` : item.label}</option>)}
          </select>
        </div>
      </>)}
      {loraSlots.map((slot) => (
        <Fragment key={slot.key}>
          <div className="form-row">
            <label className="form-row-label" htmlFor={id(slot.key)}>{slot.label}</label>
            <div className="settings-key-row">
              <input
                id={id(slot.key)}
                className="settings-input"
                spellCheck={false}
                placeholder={video ? "None (optional)" : "None (optional style file)"}
                value={files[slot.key]}
                onChange={(event) => onPatch({ [slot.key]: event.target.value }, false)}
                onBlur={onCommit}
              />
              <button className="button secondary" disabled={busy} onClick={() => void browse(slot.key)}>Browse…</button>
              {files[slot.key] && (
                <button className="button secondary" disabled={busy} onClick={() => onPatch({ [slot.key]: "" }, true)}>Clear</button>
              )}
            </div>
          </div>
          {files[slot.key] && (
            <div className="form-row">
              <label className="form-row-label" htmlFor={id(`${slot.key}-strength`)}>{slot.strengthLabel}</label>
              <div className="local-idle">
                <input
                  id={id(`${slot.key}-strength`)}
                  className="settings-input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={files[slot.strength]}
                  onChange={(event) => onPatch({ [slot.strength]: Math.max(0, Math.min(2, Number(event.target.value) || 0)) }, false)}
                  onBlur={onCommit}
                />
                <span>1 is full strength; 0 turns it off</span>
              </div>
            </div>
          )}
        </Fragment>
      ))}
      {!video && (
        <div className="form-row">
          <label className="form-row-label" htmlFor={id("prefix")}>Prompt start</label>
          <div className="local-negative">
            <input
              id={id("prefix")}
              className="settings-input"
              spellCheck={false}
              placeholder="Words before every new image's prompt"
              value={files.promptPrefix}
              onChange={(event) => onPatch({ promptPrefix: event.target.value }, false)}
              onBlur={onCommit}
            />
            {status && files.promptPrefix !== (status.defaultPromptPrefixes[model] ?? "") && (
              <button className="settings-link" onClick={() => onPatch({ promptPrefix: status.defaultPromptPrefixes[model] ?? "" }, true)}>Use the default</button>
            )}
          </div>
        </div>
      )}
      <div className="form-row form-row-top">
        <label className="form-row-label" htmlFor={id("negative")}>Negative prompt</label>
        <div className="local-negative">
          <textarea
            id={id("negative")}
            className="settings-input"
            spellCheck={false}
            placeholder={video ? "What every video avoids" : "What every image avoids"}
            value={files.negativePrompt}
            onChange={(event) => onPatch({ negativePrompt: event.target.value }, false)}
            onBlur={onCommit}
          />
          {status && files.negativePrompt !== (status.defaultNegativePrompts[model] ?? "") && (
            <button className="settings-link" onClick={() => onPatch({ negativePrompt: status.defaultNegativePrompts[model] ?? "" }, true)}>Use the default</button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings for the optional local engine: its download, and one section for
 * each local model with its files, its settings, and a load test. Image Sage
 * loads the model that a job needs; the user does not switch models here.
 */
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
  /** Each section's task progress or result, by owner. */
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const busy = Object.values(checks).some((check) => check.kind === "working");
  const saved = useRef(JSON.stringify(status?.config ?? EMPTY_CONFIG));
  const setCheck = (owner: string, next: CheckState | ((current: CheckState) => CheckState)) =>
    setChecks((current) => ({ ...current, [owner]: typeof next === "function" ? next(current[owner] ?? IDLE) : next }));

  useEffect(() => {
    if (status) return;
    localStatus().then((loaded) => {
      onStatusChange(loaded);
      setConfig(loaded.config);
      saved.current = JSON.stringify(loaded.config);
    }).catch(() => {});
  }, [status, onStatusChange]);

  const save = async (next: LocalConfig, owner = ENGINE) => {
    setConfig(next);
    const text = JSON.stringify(next);
    if (text === saved.current) return;
    saved.current = text;
    try {
      await saveLocalConfig(next);
      onStatusChange(await localStatus());
    } catch (error) {
      setCheck(owner, { kind: "error", message: String(error) });
    }
  };

  const run: RunTask = async (owner, label, action) => {
    const requestId = crypto.randomUUID();
    setCheck(owner, { kind: "working", label, requestId });
    onWorkingChange(true);
    const onPercent = (percent: number | null) =>
      setCheck(owner, (current) => current.kind === "working" ? { ...current, label: percent === null ? label : `${label} ${percent}%` } : current);
    try {
      setCheck(owner, { kind: "success", message: await action(requestId, onPercent) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCheck(owner, message === CANCELLED_MESSAGE ? IDLE : { kind: "error", message });
    } finally {
      onWorkingChange(false);
      localStatus().then(onStatusChange).catch(() => {});
    }
  };

  const download = () => run(ENGINE, "Downloading the engine…", async (requestId, onPercent) => {
    await downloadLocalEngine(requestId, (progress) => {
      if (progress.stage === "preparing") setCheck(ENGINE, (current) => current.kind === "working" ? { ...current, label: "Unpacking the engine…" } : current);
      else onPercent(progress.progress === null ? null : Math.round(progress.progress * 100));
    });
    return "The engine is installed.";
  });

  const installed = Boolean(status?.engineInstalled);
  const runningName = status?.running ? MODEL_INFO[status.running]?.name : undefined;

  return (
    <>
      <div className="settings-pane-intro">
        <h3><Cpu size={22} /> Local</h3>
        <p>
          Local models make images and short videos on this computer, free and offline. Each model below has its own
          files and settings. Image Sage loads the model that a job needs: the model of the prompt for an image, and a
          Wan 2.2 model for Make Video. Only one model is loaded at a time. The models need an NVIDIA graphics card
          (24 GB or more of graphics memory works best) and the model's files, for example from ComfyUI.
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
              <button className="button primary" disabled={busy} onClick={() => void download()}>
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
            <span>minutes without a new image or video</span>
          </div>
        </div>
        <CheckLine check={checks[ENGINE] ?? IDLE} />
      </div>

      {LOCAL_SETTINGS_MODELS.map(({ id: model }) => {
        const files = config.models[model] ?? EMPTY_FILES;
        const withPatch = (patch: Partial<LocalModelConfig>): LocalConfig => ({ ...config, models: { ...config.models, [model]: { ...files, ...patch } } });
        return (
          <ModelSection
            key={model}
            model={model}
            files={files}
            status={status}
            check={checks[model] ?? IDLE}
            busy={busy}
            onPatch={(patch, commit) => commit ? void save(withPatch(patch), model) : setConfig(withPatch(patch))}
            onCommit={() => void save(config, model)}
            onMessage={(check) => setCheck(model, check)}
            run={run}
          />
        );
      })}

      <small className="settings-help">
        A negative prompt lists what a model should avoid, such as blur and extra fingers. A prompt start goes before
        every new image's prompt; "A photo." makes Chroma1-HD draw photos unless the prompt asks for another style. A
        LoRA is a small add-on file made for one model that changes its style or motion. Wan 2.2 LoRAs often come as a
        pair, one file for the low-noise model and one for the high-noise model. Load to check loads a model into the
        graphics memory, which takes up to a minute; the first image or video also loads it. The settings apply to the
        next image or video.
      </small>
    </>
  );
}
