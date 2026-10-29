import { CheckCircle, Cpu, GearSix, PencilSimple, SpinnerGap, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { OpenAiMark } from "./BrandLogos";
import { LocalPanel } from "./LocalPanel";
import { useEffect, useState } from "react";
import { confirms, setConfirms, type Confirmation } from "../lib/confirmations";
import {
  clearApiKey,
  openApiKeysPage,
  saveApiKey,
  localReady,
  testApiKey,
  type ApiKeyStatus,
  type KeyStatuses,
  type LocalStatus,
  type Provider
} from "../lib/ai";

/** "new" is the OpenAI key; "local" is the optional local engine; "general" holds the app's own settings. */
export type SettingsSection = "new" | "local" | "general";
type KeySection = Exclude<SettingsSection, "general" | "local">;

interface Props {
  statuses: KeyStatuses;
  /** The model the key test checks the key against. */
  generateModel: string;
  initialSection: SettingsSection;
  onStatusChange: (provider: Provider, status: ApiKeyStatus) => void;
  localStatus: LocalStatus | null;
  onLocalStatusChange: (status: LocalStatus) => void;
  onClose: () => void;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

const SECTIONS: Record<KeySection, { label: string; service: string; provider: Provider; description: string; keyHelp: string; placeholder: string }> = {
  new: {
    label: "OpenAI",
    service: "OpenAI",
    provider: "openai",
    description: "OpenAI GPT Image creates new images from a prompt and edits the whole image. Each image is paid from your API credits.",
    keyHelp: "Create a key at platform.openai.com → API keys, with Images set to Request and List models set to Read.",
    placeholder: "sk-…"
  }
};

function KeyPanel({
  section,
  status,
  model,
  onStatusChange,
  onWorkingChange
}: {
  section: KeySection;
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
          <small className="settings-help">
            {copy.keyHelp} The key is stored in Windows Credential Manager.
            {!status.connected && (
              <>
                {" "}
                <button className="settings-link" onClick={() => void openApiKeysPage().catch(() => {})}>Manage your OpenAI API keys</button>
              </>
            )}
          </small>
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

/** The confirmations the app can ask before it changes your work, each with its own check box. */
const CONFIRMATIONS: { id: Confirmation; label: string }[] = [
  { id: "delete", label: "Confirm when deleting a layer" },
  { id: "regenerate", label: "Confirm before regenerating a layer" }
];

/** The General section: the app's own settings. */
function GeneralPanel() {
  const [on, setOn] = useState(() => Object.fromEntries(CONFIRMATIONS.map(({ id }) => [id, confirms(id)])) as Record<Confirmation, boolean>);
  return (
    <>
      <div className="settings-pane-intro">
        <h3><GearSix size={22} /> General</h3>
        <p>"Don't show again" in a confirmation turns it off here; check it to see the confirmation again.</p>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Confirmations</div>
        {CONFIRMATIONS.map(({ id, label }) => (
          <label key={id} className="settings-toggle">
            <input
              type="checkbox"
              checked={on[id]}
              onChange={(event) => {
                setConfirms(id, event.target.checked);
                setOn((current) => ({ ...current, [id]: event.target.checked }));
              }}
            />
            {label}
          </label>
        ))}
      </div>
    </>
  );
}

export function ConnectDialog({ statuses, generateModel, initialSection, onStatusChange, localStatus, onLocalStatusChange, onClose }: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [workingCount, setWorkingCount] = useState(0);
  const working = workingCount > 0;
  const onWorkingChange = (next: boolean) => setWorkingCount((count) => Math.max(0, count + (next ? 1 : -1)));
  const copy = section === "general" || section === "local" ? null : SECTIONS[section];
  const localNote = !localStatus?.engineInstalled ? "Not installed" : localReady(localStatus) ? "Ready" : "Choose model files";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, working]);

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
            {(Object.keys(SECTIONS) as KeySection[]).map((id) => {
              const item = SECTIONS[id];
              const connected = statuses[item.provider].connected;
              return (
                <button
                  key={id}
                  className={section === id ? "active" : ""}
                  aria-current={section === id ? "page" : undefined}
                  onClick={() => setSection(id)}
                >
                  <OpenAiMark size={20} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{connected ? "Connected" : "No key"}</small>
                  </span>
                  <i className={`settings-nav-dot ${connected ? "connected" : ""}`} aria-hidden="true" />
                </button>
              );
            })}
            <button
              className={section === "local" ? "active" : ""}
              aria-current={section === "local" ? "page" : undefined}
              onClick={() => setSection("local")}
            >
              <Cpu size={20} />
              <span>
                <strong>Local</strong>
                <small>{localNote}</small>
              </span>
              <i className={`settings-nav-dot ${localReady(localStatus) ? "connected" : ""}`} aria-hidden="true" />
            </button>
            <button
              className={section === "general" ? "active" : ""}
              aria-current={section === "general" ? "page" : undefined}
              onClick={() => setSection("general")}
            >
              <GearSix size={20} />
              <span>
                <strong>General</strong>
                <small>Confirmations</small>
              </span>
            </button>
          </nav>

          <div className="settings-pane">
            {section === "local" ? (
              <LocalPanel status={localStatus} onStatusChange={onLocalStatusChange} onWorkingChange={onWorkingChange} />
            ) : copy && section !== "general" ? (
              <>
                <div className="settings-pane-intro">
                  <h3><OpenAiMark size={22} /> {copy.label}</h3>
                  <p>{copy.description}</p>
                </div>

                <KeyPanel
                  key={section}
                  section={section}
                  status={statuses[copy.provider]}
                  model={generateModel}
                  onStatusChange={onStatusChange}
                  onWorkingChange={onWorkingChange}
                />
              </>
            ) : <GeneralPanel />}
          </div>
        </div>

        <footer className="save-dialog-actions">
          <button className="button primary" disabled={working} onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
