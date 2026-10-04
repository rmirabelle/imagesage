use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, future::Future, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tokio::task::AbortHandle;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REQUEST_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const CANCELLED: &str = "The request was cancelled.";

/// Running AI requests, so the user can cancel one by its id.
#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<String, AbortHandle>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiProgress {
    request_id: String,
    stage: &'static str,
    progress: Option<f64>,
    partial_index: Option<u64>,
    partial_data_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiImage {
    pub data_url: String,
    pub usage: Option<Value>,
}

/// Sends `ai-progress` events for one request.
#[derive(Clone)]
pub struct ProgressReporter {
    app: AppHandle,
    request_id: String,
}

impl ProgressReporter {
    pub fn stage(&self, stage: &'static str) {
        self.send(stage, None, None, None);
    }

    pub fn progress(&self, stage: &'static str, progress: f64) {
        self.send(stage, Some(progress.clamp(0.0, 1.0)), None, None);
    }

    pub fn partial(&self, index: u64, data_url: String) {
        self.send("partial", None, Some(index), Some(data_url));
    }

    fn send(
        &self,
        stage: &'static str,
        progress: Option<f64>,
        partial_index: Option<u64>,
        partial_data_url: Option<String>,
    ) {
        let _ = self.app.emit(
            "ai-progress",
            AiProgress {
                request_id: self.request_id.clone(),
                stage,
                progress,
                partial_index,
                partial_data_url,
            },
        );
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("ImageSage/", env!("CARGO_PKG_VERSION")))
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("Could not start the network client: {error}"))
}

pub fn describe_transport_error(service: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("{service} did not answer in time. Try again.")
    } else if error.is_connect() {
        format!("Could not reach {service}. Check the network connection.")
    } else {
        format!("The connection to {service} failed: {}", error_chain(error))
    }
}

/// Joins an error with its causes, because reqwest's own message hides the real reason.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// Decodes a `data:image/png;base64,` URL and enforces the upload size limit.
pub fn decode_png(data_url: &str, label: &str) -> Result<Vec<u8>, String> {
    let (prefix, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| format!("The {label} is invalid"))?;
    if !prefix.eq_ignore_ascii_case("data:image/png;base64") {
        return Err(format!("The {label} must be a PNG image"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Could not decode the {label}: {error}"))?;
    if bytes.len() > MAX_REQUEST_IMAGE_BYTES {
        return Err(format!("The {label} is larger than the 50 MB upload limit"));
    }
    Ok(bytes)
}

/// Runs one AI request as a task that `ai_cancel` can abort.
pub async fn run_cancellable<T, F, Fut>(
    app: AppHandle,
    requests: &AiRequests,
    request_id: String,
    work: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(ProgressReporter) -> Fut,
    Fut: Future<Output = Result<T, String>> + Send + 'static,
{
    let reporter = ProgressReporter {
        app,
        request_id: request_id.clone(),
    };
    let task = tokio::spawn(work(reporter));
    requests
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(request_id.clone(), task.abort_handle());
    let result = task.await;
    requests
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&request_id);
    match result {
        Ok(outcome) => outcome,
        Err(error) if error.is_cancelled() => Err(CANCELLED.into()),
        Err(error) => Err(format!("The AI request stopped unexpectedly: {error}")),
    }
}

#[tauri::command]
pub fn ai_cancel(requests: State<'_, AiRequests>, request_id: String) {
    if let Some(handle) = requests
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&request_id)
    {
        handle.abort();
    }
}
