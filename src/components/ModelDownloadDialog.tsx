import { ArrowClockwise, CircleNotch, DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { CANCELLED_MESSAGE, cancelAiRequest } from "../lib/ai";
import { downloadModel, formatMegabytes, MODEL_INFO, type ModelId } from "../lib/models";

interface Props {
  model: ModelId;
  sizeBytes: number;
  /** Called once: true when the model is downloaded, false when the user does not want it. */
  onDone: (installed: boolean) => void;
}

type State =
  | { kind: "ask" }
  | { kind: "downloading"; progress: number }
  | { kind: "error"; message: string };

/** Asks before a model's one-time download, then shows its progress. */
export function ModelDownloadDialog({ model, sizeBytes, onDone }: Props) {
  const info = MODEL_INFO[model];
  const [state, setState] = useState<State>({ kind: "ask" });
  const requestRef = useRef<string | null>(null);
  const downloading = state.kind === "downloading";

  const cancel = () => {
    if (requestRef.current) void cancelAiRequest(requestRef.current);
    else onDone(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const download = async () => {
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setState({ kind: "downloading", progress: 0 });
    try {
      await downloadModel(model, requestId, (event) => {
        if (event.progress !== null) setState({ kind: "downloading", progress: event.progress });
      });
      onDone(true);
    } catch (error) {
      const message = String(error);
      if (message === CANCELLED_MESSAGE) onDone(false);
      else setState({ kind: "error", message });
    } finally {
      requestRef.current = null;
    }
  };

  const percent = downloading ? Math.round(state.progress * 100) : 0;

  return (
    <div className="about-dialog-overlay" role="presentation">
      <div className="about-dialog model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
        <div className="model-dialog-body">
          <h2 id="model-dialog-title">Download the {info.name}?</h2>
          <p>
            {info.uses} a model that runs on this PC. It is a one-time download of {formatMegabytes(sizeBytes)}.
            After that it works offline and costs nothing.
          </p>
          {downloading && (
            <div className="model-dialog-status">
              <span><CircleNotch className="spin" size={15} /> Downloading — {percent}%</span>
              <div className="about-update-progress"><i style={{ width: `${Math.max(percent, 2)}%` }} /></div>
            </div>
          )}
          {state.kind === "error" && (
            <div className="about-update-status error"><WarningCircle size={17} weight="fill" /> {state.message}</div>
          )}
        </div>
        <footer className="about-dialog-actions">
          <button className="button secondary" onClick={cancel}>Cancel</button>
          {!downloading && (
            <button className="button primary" onClick={() => void download()}>
              {state.kind === "error" ? <><ArrowClockwise size={15} /> Try again</> : <><DownloadSimple size={15} /> Download</>}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
