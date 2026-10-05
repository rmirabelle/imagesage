import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowClockwise,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  FloppyDisk,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { checkForUpdate, type UpdateInfo } from "../lib/updater";

interface Props {
  version: string;
  initialUpdateInfo: UpdateInfo | null;
  onClose: () => void;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; downloaded: number; total: number }
  | { kind: "error"; message: string };

export function AboutDialog({ version, initialUpdateInfo, onClose }: Props) {
  const [state, setState] = useState<CheckState>(
    initialUpdateInfo ? { kind: "available", info: initialUpdateInfo } : { kind: "idle" }
  );

  useEffect(() => {
    if (initialUpdateInfo) setState({ kind: "available", info: initialUpdateInfo });
  }, [initialUpdateInfo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.kind !== "downloading") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, state.kind]);

  useEffect(() => {
    if (state.kind !== "downloading") return;
    const unlisten = listen<{ downloaded: number; total: number }>("update-progress", (event) => {
      setState((current) => current.kind === "downloading"
        ? { ...current, downloaded: event.payload.downloaded, total: event.payload.total }
        : current);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [state.kind]);

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const info = await checkForUpdate();
      setState(info ? { kind: "available", info } : { kind: "upToDate" });
    } catch (error) {
      setState({ kind: "error", message: `Could not check for updates. ${String(error)}` });
    }
  };

  const download = async () => {
    if (state.kind !== "available") return;
    const info = state.info;
    setState({ kind: "downloading", info, downloaded: 0, total: 0 });
    try {
      await invoke("download_and_run_installer", {
        url: info.downloadUrl,
        assetName: info.assetName
      });
    } catch (error) {
      setState({ kind: "error", message: `Could not install the update. ${String(error)}` });
    }
  };

  const downloading = state.kind === "downloading";

  return (
    <div className="about-dialog-overlay" role="presentation" onPointerDown={() => !downloading && onClose()}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {!downloading && (
          <button className="about-dialog-close" onClick={onClose} aria-label="Close About ImageSage" data-help="Close">
            <X size={18} />
          </button>
        )}
        <div className="about-dialog-content">
          <div className="about-app-icon"><img src="/icon.ico" alt="" /></div>
          <div className="about-dialog-copy">
            <h2 id="about-title">ImageSage</h2>
            <div className="about-version">Version {version || "—"}</div>
            <p>Prompt. Refine. Repeat.</p>
            <span>by Robert Mirabelle</span>
            <UpdateSection state={state} onCheck={() => void check()} onDownload={() => void download()} />
          </div>
        </div>
        {!downloading && (
          <footer className="about-dialog-actions">
            <button className="button secondary" onClick={onClose}>Close</button>
          </footer>
        )}
      </div>
    </div>
  );
}

function UpdateSection({
  state,
  onCheck,
  onDownload
}: {
  state: CheckState;
  onCheck: () => void;
  onDownload: () => void;
}) {
  if (state.kind === "idle") {
    return (
      <button className="about-update-button" onClick={onCheck}>
        <ArrowClockwise size={15} /> Check for Updates
      </button>
    );
  }
  if (state.kind === "checking") {
    return <div className="about-update-status"><CircleNotch className="spin" size={16} /> Checking for updates…</div>;
  }
  if (state.kind === "upToDate") {
    return (
      <div className="about-update-result">
        <div className="about-update-status success"><CheckCircle size={17} weight="fill" /> ImageSage is up to date.</div>
        <button className="about-update-link" onClick={onCheck}><ArrowClockwise size={13} /> Check again</button>
      </div>
    );
  }
  if (state.kind === "available") {
    return (
      <div className="about-update-result">
        <div className="about-update-available"><DownloadSimple size={18} weight="fill" /> Version {state.info.latestVersion} is available</div>
        <small>You’re currently using version {state.info.currentVersion}.</small>
        <button className="button primary about-install-button" onClick={onDownload}>
          <FloppyDisk size={16} weight="bold" /> Download and Install
        </button>
      </div>
    );
  }
  if (state.kind === "downloading") {
    const percent = state.total > 0 ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;
    return (
      <div className="about-update-result">
        <div className="about-update-status"><CircleNotch className="spin" size={16} /> Downloading version {state.info.latestVersion}{percent === null ? "…" : ` — ${percent}%`}</div>
        <div className="about-update-progress"><i style={{ width: `${percent ?? 10}%` }} /></div>
        <small>When the download finishes, ImageSage closes, installs the update with no setup pages, and opens again.</small>
      </div>
    );
  }
  return (
    <div className="about-update-result">
      <div className="about-update-status error"><WarningCircle size={17} weight="fill" /> {state.message}</div>
      <button className="about-update-link" onClick={onCheck}><ArrowClockwise size={13} /> Try again</button>
    </div>
  );
}
