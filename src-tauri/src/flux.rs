use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::credentials::{self, Provider};
use crate::requests::{self, AiImage, AiRequests, ProgressReporter};

const SERVICE: &str = "FLUX";
const API_BASE: &str = "https://api.bfl.ai/v1";
const EDIT_MODEL: &str = "flux-3-image";
const POLL_INTERVAL: Duration = Duration::from_millis(800);
const SAFETY_TOLERANCE: u8 = 2;
const RESOLUTIONS: [&str; 5] = ["768sq", "1k", "1.5k", "2k", "4k"];

/// A FLUX 3 Image edit of one square region. The prompt already carries the target box.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    request_id: String,
    prompt: String,
    image_png: String,
    resolution: String,
}

fn transport_error(error: &reqwest::Error) -> String {
    requests::describe_transport_error(SERVICE, error)
}

/// BFL reports errors as `{"detail": "..."}` or a list of validation entries.
fn error_detail(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    match value.get("detail") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("msg").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("; "),
        _ => String::new(),
    }
}

/// Turns a FLUX HTTP failure into a message the user can act on.
fn describe_error(status: u16, body: &str) -> String {
    let detail = error_detail(body);
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(" FLUX says: {detail}")
    };
    match status {
        401 | 403 => {
            format!("FLUX rejected the API key. Check or replace it in Settings.{suffix}")
        }
        402 => format!("The FLUX account has no credits left. Add credits at api.bfl.ai.{suffix}"),
        422 => format!("FLUX could not accept the request.{suffix}"),
        429 => format!(
            "FLUX has too many active requests for this account. Wait and try again.{suffix}"
        ),
        500..=599 => format!("FLUX had a server error ({status}). Try again.{suffix}"),
        _ => format!("FLUX returned HTTP {status}.{suffix}"),
    }
}

/// Strips a `data:...;base64,` prefix; BFL wants bare base64.
fn bare_base64(data_url: &str) -> &str {
    data_url.split_once(',').map_or(data_url, |(_, data)| data)
}

/// The API key goes only to BFL's own hosts, never to a URL from elsewhere.
fn is_bfl_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|parsed| {
        parsed.scheme() == "https"
            && parsed
                .host_str()
                .is_some_and(|host| host == "bfl.ai" || host.ends_with(".bfl.ai"))
    })
}

/// What one poll of a FLUX task means.
#[derive(Debug, PartialEq)]
enum PollState {
    Working(Option<f64>),
    Ready(String),
    Failed(String),
}

fn parse_poll(value: &Value) -> PollState {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match status {
        "Ready" => value
            .pointer("/result/sample")
            .and_then(Value::as_str)
            .map(|url| PollState::Ready(url.to_string()))
            .unwrap_or_else(|| {
                PollState::Failed("FLUX finished without returning an image.".into())
            }),
        "Request Moderated" | "Content Moderated" => PollState::Failed(
            "FLUX's safety filter blocked this edit. Change the prompt or the selection.".into(),
        ),
        "Error" | "Failed" => {
            PollState::Failed("FLUX could not complete the edit. Try again.".into())
        }
        "Task not found" => PollState::Failed("FLUX lost track of the request. Try again.".into()),
        _ => PollState::Working(value.get("progress").and_then(Value::as_f64)),
    }
}

async fn edit(
    reporter: ProgressReporter,
    key: String,
    request: EditRequest,
) -> Result<AiImage, String> {
    let client = requests::client()?;
    requests::decode_png(&request.image_png, "region image")?;
    if !RESOLUTIONS.contains(&request.resolution.as_str()) {
        return Err(format!(
            "Unsupported FLUX resolution: {}",
            request.resolution
        ));
    }
    // The region is always square, so the result keeps a 1:1 aspect ratio and pastes back without distortion.
    let body = json!({
        "prompt": request.prompt,
        "images": [bare_base64(&request.image_png)],
        "aspect_ratio": "1:1",
        "resolution": request.resolution,
        "safety_tolerance": SAFETY_TOLERANCE
    });

    reporter.stage("sending");
    let response = client
        .post(format!("{API_BASE}/{EDIT_MODEL}"))
        .header("x-key", &key)
        .json(&body)
        .send()
        .await
        .map_err(|error| transport_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(describe_error(status.as_u16(), &text));
    }
    let submitted: Value = response
        .json()
        .await
        .map_err(|error| format!("FLUX sent an unreadable answer: {error}"))?;
    let task_id = submitted
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "FLUX did not return a task id.".to_string())?;
    let polling_url = submitted
        .get("polling_url")
        .and_then(Value::as_str)
        .filter(|url| is_bfl_url(url))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{API_BASE}/get_result?id={task_id}"));

    reporter.stage("generating");
    let sample_url = loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let response = client
            .get(&polling_url)
            .header("x-key", &key)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(describe_error(status.as_u16(), &text));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("FLUX sent an unreadable status: {error}"))?;
        match parse_poll(&value) {
            PollState::Working(Some(progress)) => reporter.progress("generating", progress),
            PollState::Working(None) => {}
            PollState::Ready(url) => break url,
            PollState::Failed(message) => return Err(message),
        }
    };

    reporter.stage("finishing");
    // The sample URL is a signed download link; it needs no key.
    let response = client
        .get(&sample_url)
        .send()
        .await
        .map_err(|error| transport_error(&error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download the FLUX result (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| transport_error(&error))?;
    let mime_type = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => return Err("FLUX returned a file that is not an image.".into()),
    };
    Ok(AiImage {
        data_url: format!("data:{mime_type};base64,{}", STANDARD.encode(&bytes)),
        usage: submitted.get("cost").cloned(),
    })
}

#[tauri::command]
pub async fn flux_edit(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: EditRequest,
) -> Result<AiImage, String> {
    let key = credentials::api_key(Provider::Flux)?;
    let request_id = request.request_id.clone();
    requests::run_cancellable(app, &requests, request_id, move |reporter| {
        edit(reporter, key, request)
    })
    .await
}

/// The saved FLUX key's credit balance (one credit is one US cent).
#[tauri::command]
pub async fn flux_credits() -> Result<f64, String> {
    let key = credentials::api_key(Provider::Flux)?;
    let response = requests::client()?
        .get(format!("{API_BASE}/credits"))
        .header("x-key", key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| transport_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(describe_error(status.as_u16(), &text));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("FLUX sent an unreadable balance: {error}"))?;
    value
        .get("credits")
        .and_then(Value::as_f64)
        .ok_or_else(|| "FLUX did not report a credit balance.".to_string())
}

/// Checks a FLUX key by reading the account's credit balance.
pub async fn test_key(key: String) -> Result<String, String> {
    let response = requests::client()?
        .get(format!("{API_BASE}/credits"))
        .header("x-key", key)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| transport_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(describe_error(status.as_u16(), &text));
    }
    let value: Value = response.json().await.unwrap_or(Value::Null);
    Ok(match value.get("credits").and_then(Value::as_f64) {
        Some(credits) => format!("The FLUX key works. Credits left: {credits:.2}."),
        None => "The FLUX key works.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_the_key_only_to_bfl_hosts() {
        assert!(is_bfl_url("https://api.us1.bfl.ai/v1/get_result?id=1"));
        assert!(is_bfl_url("https://api.bfl.ai/v1/get_result?id=1"));
        assert!(!is_bfl_url("http://api.bfl.ai/v1/get_result?id=1"));
        assert!(!is_bfl_url("https://bfl.ai.example.com/poll"));
        assert!(!is_bfl_url("https://evilbfl.ai/poll"));
    }

    #[test]
    fn reads_poll_states() {
        let ready =
            json!({ "status": "Ready", "result": { "sample": "https://delivery.bfl.ai/x.png" } });
        assert_eq!(
            parse_poll(&ready),
            PollState::Ready("https://delivery.bfl.ai/x.png".into())
        );
        assert_eq!(
            parse_poll(&json!({ "status": "Pending", "progress": 0.4 })),
            PollState::Working(Some(0.4))
        );
        assert!(
            matches!(parse_poll(&json!({ "status": "Content Moderated" })), PollState::Failed(message) if message.contains("safety"))
        );
        assert!(matches!(
            parse_poll(&json!({ "status": "Ready" })),
            PollState::Failed(_)
        ));
    }

    #[test]
    fn maps_errors_and_details() {
        assert!(describe_error(402, "").contains("no credits"));
        let body = "{\"detail\":[{\"msg\":\"mask size mismatch\"}]}";
        assert!(describe_error(422, body).ends_with("mask size mismatch"));
        assert_eq!(bare_base64("data:image/png;base64,QUJD"), "QUJD");
    }
}
