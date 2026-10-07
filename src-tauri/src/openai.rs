use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::credentials::{self, Provider};
use crate::requests::{self, AiImage, AiRequests, ProgressReporter};

const SERVICE: &str = "OpenAI";
const API_BASE: &str = "https://api.openai.com/v1";
const PARTIAL_IMAGES: u8 = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    request_id: String,
    prompt: String,
    model: String,
    quality: String,
    size: String,
}

/// The most useful text in an error body: a known message field, or the raw body itself.
fn error_detail(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let known = parsed.as_ref().and_then(|value| {
        [
            "/error/message",
            "/error/code",
            "/error",
            "/detail",
            "/message",
        ]
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(str::to_string)
    });
    let text = known.unwrap_or_else(|| body.trim().to_string());
    let mut shortened: String = text.chars().take(400).collect();
    if text.chars().count() > 400 {
        shortened.push('…');
    }
    shortened
}

/// Turns an OpenAI HTTP failure into a message the user can act on.
fn describe_error(status: u16, body: &str) -> String {
    eprintln!("[imagesage] OpenAI HTTP {status}: {body}");
    let detail = error_detail(body);
    let detail_suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(" OpenAI says: {detail}")
    };
    match status {
        401 => format!("OpenAI rejected the API key. Check or replace it in Connect.{detail_suffix}"),
        403 => format!(
            "This OpenAI account cannot use the image model yet. Image models can require organization verification on platform.openai.com.{detail_suffix}"
        ),
        404 => format!("OpenAI does not offer that model to this account.{detail_suffix}"),
        400 if detail.to_ascii_lowercase().contains("safety") => {
            format!("OpenAI's safety system blocked this request.{detail_suffix}")
        }
        400 => format!("OpenAI could not accept the request.{detail_suffix}"),
        429 => format!("OpenAI rate limit or quota reached. Wait, or check billing.{detail_suffix}"),
        500..=599 => format!("OpenAI had a server error ({status}). Try again.{detail_suffix}"),
        _ => format!("OpenAI returned HTTP {status}.{detail_suffix}"),
    }
}

fn transport_error(error: &reqwest::Error) -> String {
    requests::describe_transport_error(SERVICE, error)
}

fn png_data_url(b64: &str) -> String {
    format!("data:image/png;base64,{b64}")
}

/// What one server-sent event means for the request.
#[derive(Debug, PartialEq)]
enum StreamEvent {
    Partial { index: u64, b64: String },
    Completed { b64: String, usage: Option<Value> },
    Failed(String),
    Ignored,
}

/// How long a stream may send nothing before the request fails.
const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

fn parse_event(data: &str) -> StreamEvent {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return StreamEvent::Ignored;
    };
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let b64 = value
        .get("b64_json")
        .and_then(Value::as_str)
        .map(str::to_string);
    if kind.ends_with(".partial_image") {
        if let Some(b64) = b64 {
            let index = value
                .get("partial_image_index")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            return StreamEvent::Partial { index, b64 };
        }
    } else if kind.ends_with(".completed") {
        if let Some(b64) = b64 {
            return StreamEvent::Completed {
                b64,
                usage: value.get("usage").cloned(),
            };
        }
        return StreamEvent::Failed("OpenAI finished without returning an image.".into());
    } else if kind == "error"
        || kind.ends_with(".failed")
        || kind.ends_with(".incomplete")
        || value.get("error").is_some()
    {
        let message = value
            .pointer("/error/message")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("OpenAI reported an error during generation.");
        return StreamEvent::Failed(message.to_string());
    }
    StreamEvent::Ignored
}

/**
 * Collects server-sent-event text and yields each complete block's `data:`
 * payload. Carriage returns are dropped on entry, and the scan resumes where it
 * stopped, so multi-megabyte image payloads are not rescanned for every chunk.
 */
#[derive(Default)]
struct SseBuffer {
    text: String,
    scanned: usize,
}

impl SseBuffer {
    fn push(&mut self, chunk: &str) {
        self.text
            .extend(chunk.chars().filter(|character| *character != '\r'));
    }

    fn drain(&mut self) -> Vec<String> {
        let mut payloads = Vec::new();
        while let Some(offset) = self.text[self.scanned..].find("\n\n") {
            let end = self.scanned + offset;
            let block: String = self.text.drain(..end + 2).collect();
            self.scanned = 0;
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if !data.is_empty() && data != "[DONE]" {
                payloads.push(data);
            }
        }
        // A blank-line separator may straddle the next chunk, so rescan the final byte.
        self.scanned = self.text.len().saturating_sub(1);
        payloads
    }
}

/// How many times a request is sent when the connection fails before OpenAI accepts it.
const SEND_ATTEMPTS: u32 = 3;

/**
 * Sends a request, and sends it again (with a new connection) when the
 * connection fails before OpenAI answers, such as a TLS "BadRecordMac" alert.
 * OpenAI has not accepted the request then, so a retry costs nothing. A
 * timeout is not retried.
 */
async fn send_with_retry<F>(make: &F) -> Result<reqwest::Response, String>
where
    F: Fn() -> Result<reqwest::RequestBuilder, String>,
{
    let mut attempt = 1;
    loop {
        match make()?.send().await {
            Ok(response) => return Ok(response),
            Err(error) if attempt < SEND_ATTEMPTS && !error.is_timeout() => {
                eprintln!(
                    "[imagesage] OpenAI send failed (attempt {attempt} of {SEND_ATTEMPTS}), retrying: {}",
                    transport_error(&error)
                );
                tokio::time::sleep(Duration::from_millis(750 * u64::from(attempt))).await;
                attempt += 1;
            }
            Err(error) => return Err(transport_error(&error)),
        }
    }
}

async fn stream_image<F>(reporter: ProgressReporter, make: F) -> Result<AiImage, String>
where
    F: Fn() -> Result<reqwest::RequestBuilder, String>,
{
    reporter.stage("sending");
    let response = send_with_retry(&make).await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(describe_error(status.as_u16(), &body));
    }
    reporter.stage("generating");

    let is_event_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    if !is_event_stream {
        // Some proxies and models answer without streaming; accept the plain JSON form too.
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("OpenAI sent an unreadable answer: {error}"))?;
        let b64 = value
            .pointer("/data/0/b64_json")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "OpenAI did not return an image.".to_string())?;
        return Ok(AiImage {
            data_url: png_data_url(&b64),
            usage: value.get("usage").cloned(),
        });
    }

    let mut stream = response.bytes_stream();
    let mut buffer = SseBuffer::default();
    let mut pending_utf8 = Vec::new();
    loop {
        // A stream that goes quiet for too long ends with an error, so a request never waits forever.
        let Ok(next) = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await else {
            eprintln!("[imagesage] OpenAI stream idle timeout");
            return Err("OpenAI stopped sending data before the image was finished. Try again.".into());
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| transport_error(&error))?;
        pending_utf8.extend_from_slice(&chunk);
        // Keep any incomplete UTF-8 sequence at the end for the next chunk.
        let valid = match std::str::from_utf8(&pending_utf8) {
            Ok(text) => text.len(),
            Err(error) => error.valid_up_to(),
        };
        buffer.push(std::str::from_utf8(&pending_utf8[..valid]).unwrap_or_default());
        pending_utf8.drain(..valid);
        for payload in buffer.drain() {
            match parse_event(&payload) {
                StreamEvent::Partial { index, b64 } => {
                    eprintln!("[imagesage] OpenAI partial image {index} ({} KB)", b64.len() / 1024);
                    reporter.partial(index, png_data_url(&b64));
                }
                StreamEvent::Completed { b64, usage } => {
                    reporter.stage("finishing");
                    return Ok(AiImage {
                        data_url: png_data_url(&b64),
                        usage,
                    });
                }
                StreamEvent::Failed(message) => {
                    eprintln!("[imagesage] OpenAI stream error: {}", payload.chars().take(600).collect::<String>());
                    return Err(message);
                }
                StreamEvent::Ignored => {
                    eprintln!("[imagesage] OpenAI stream event ignored: {}", payload.chars().take(600).collect::<String>());
                }
            }
        }
    }
    eprintln!("[imagesage] OpenAI stream closed without an image");
    Err("The connection closed before OpenAI finished the image.".into())
}

/// An OpenAI answer that a dev build acts out instead of calling OpenAI.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Simulated {
    /// OpenAI refuses the prompt before it starts (HTTP 400 from the safety system).
    Blocked,
    /// OpenAI starts, then sends an error event in the stream.
    StreamError,
    /// OpenAI streams its partial images a few seconds apart, then the final image.
    Partials,
}

/**
 * In dev builds only, a prompt that starts with `[test:blocked]`,
 * `[test:stream-error]` or `[test:partials]` acts out an OpenAI answer, so
 * the app can be tested without cost and without a violating prompt.
 */
fn simulated_answer(prompt: &str) -> Option<Simulated> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let prompt = prompt.trim_start();
    if prompt.starts_with("[test:blocked]") {
        Some(Simulated::Blocked)
    } else if prompt.starts_with("[test:stream-error]") {
        Some(Simulated::StreamError)
    } else if prompt.starts_with("[test:partials]") {
        Some(Simulated::Partials)
    } else {
        None
    }
}

/// A solid-color PNG data URL of the requested size ("1024x1536"; 1024 square when it cannot be read).
fn solid_png(size: &str, color: [u8; 3]) -> Result<String, String> {
    let (width, height) = size
        .split_once('x')
        .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
        .unwrap_or((1024, 1024));
    let image = image::RgbaImage::from_pixel(width, height, image::Rgba([color[0], color[1], color[2], 255]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| format!("Could not draw the simulated image: {error}"))?;
    use base64::Engine;
    Ok(png_data_url(&base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())))
}

/// `make` builds the request; it is called again for each retry, because a multipart body cannot be sent twice.
async fn send_or_simulate<F>(
    reporter: ProgressReporter,
    make: F,
    simulated: Option<Simulated>,
    size: String,
) -> Result<AiImage, String>
where
    F: Fn() -> Result<reqwest::RequestBuilder, String>,
{
    let Some(answer) = simulated else {
        return stream_image(reporter, make).await;
    };
    reporter.stage("sending");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    match answer {
        Simulated::Blocked => Err(describe_error(
            400,
            "{\"error\":{\"message\":\"Your request was rejected by the safety system (simulated).\",\"code\":\"moderation_blocked\"}}",
        )),
        Simulated::StreamError => {
            reporter.stage("generating");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            match parse_event("{\"type\":\"error\",\"error\":{\"message\":\"Your request was rejected by the safety system (simulated, in the stream).\"}}") {
                StreamEvent::Failed(message) => Err(message),
                _ => Err("The simulated stream error was not recognized.".into()),
            }
        }
        Simulated::Partials => {
            reporter.stage("generating");
            for (index, color) in [[150, 40, 40], [40, 130, 60], [40, 70, 160]].into_iter().enumerate() {
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                reporter.partial(index as u64, solid_png(&size, color)?);
            }
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            reporter.stage("finishing");
            Ok(AiImage {
                data_url: solid_png(&size, [120, 120, 120])?,
                usage: None,
            })
        }
    }
}

#[tauri::command]
pub async fn ai_generate(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: GenerateRequest,
) -> Result<AiImage, String> {
    let key = credentials::api_key(Provider::OpenAi)?;
    let simulated = simulated_answer(&request.prompt);
    let size = request.size.clone();
    let body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "size": request.size,
        "quality": request.quality,
        "output_format": "png",
        "n": 1,
        "stream": true,
        "partial_images": PARTIAL_IMAGES
    });
    let make = move || {
        Ok(requests::client()?
            .post(format!("{API_BASE}/images/generations"))
            .bearer_auth(&key)
            .json(&body))
    };
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| {
        send_or_simulate(reporter, make, simulated, size)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WholeEditRequest {
    request_id: String,
    prompt: String,
    model: String,
    quality: String,
    size: String,
    image_png: String,
}

/// Edits the whole image with GPT Image through the Images API edit endpoint.
#[tauri::command]
pub async fn ai_edit_whole(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: WholeEditRequest,
) -> Result<AiImage, String> {
    let key = credentials::api_key(Provider::OpenAi)?;
    let image = requests::decode_png(&request.image_png, "image")?;
    let simulated = simulated_answer(&request.prompt);
    let WholeEditRequest { request_id, model, prompt, size, quality, .. } = request;
    let request_size = size.clone();
    let make = move || {
        let part = reqwest::multipart::Part::bytes(image.clone())
            .file_name("image.png")
            .mime_str("image/png")
            .map_err(|error| format!("Could not prepare the upload: {error}"))?;
        let form = reqwest::multipart::Form::new()
            .text("model", model.clone())
            .text("prompt", prompt.clone())
            .text("size", request_size.clone())
            .text("quality", quality.clone())
            .text("output_format", "png")
            .text("n", "1")
            .text("stream", "true")
            .text("partial_images", PARTIAL_IMAGES.to_string())
            .part("image", part);
        Ok(requests::client()?
            .post(format!("{API_BASE}/images/edits"))
            .bearer_auth(&key)
            .multipart(form))
    };
    requests::run_cancellable(app, &requests, request_id, move |reporter| {
        send_or_simulate(reporter, make, simulated, size)
    })
    .await
}

/// Checks an OpenAI key (the given one, or the saved one) against the chosen model.
pub async fn test_key(key: String, model: &str) -> Result<String, String> {
    let response = requests::client()?
        .get(format!("{API_BASE}/models/{model}"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| transport_error(&error))?;
    let status = response.status();
    if status.is_success() {
        return Ok(format!("The key works with {model}."));
    }
    let body = response.text().await.unwrap_or_default();
    Err(describe_error(status.as_u16(), &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_complete_blocks_and_keeps_the_rest() {
        let mut buffer = SseBuffer::default();
        buffer.push(
            "event: image_edit.partial_image\r\ndata: {\"type\":\"image_edit.partial_image\",\"b64_json\":\"AA\",\"partial_image_index\":0}\r\n\r\nevent: image_edit.completed\ndata: {\"type\":",
        );
        let payloads = buffer.drain();
        assert_eq!(payloads.len(), 1);
        assert_eq!(
            parse_event(&payloads[0]),
            StreamEvent::Partial {
                index: 0,
                b64: "AA".into()
            }
        );
        buffer.push("\"image_edit.completed\",\"b64_json\":\"BB\"}\n");
        assert!(buffer.drain().is_empty());
        buffer.push("\n");
        let payloads = buffer.drain();
        assert_eq!(
            parse_event(&payloads[0]),
            StreamEvent::Completed {
                b64: "BB".into(),
                usage: None
            }
        );
        assert!(buffer.text.is_empty());
    }

    #[test]
    fn reports_stream_errors() {
        let event = parse_event("{\"type\":\"error\",\"error\":{\"message\":\"blocked\"}}");
        assert_eq!(event, StreamEvent::Failed("blocked".into()));
        assert_eq!(parse_event("not json"), StreamEvent::Ignored);
        assert!(matches!(parse_event("{\"type\":\"image_edit.failed\"}"), StreamEvent::Failed(_)));
        assert!(matches!(parse_event("{\"type\":\"image_generation.incomplete\"}"), StreamEvent::Failed(_)));
    }

    #[test]
    fn test_prompts_act_out_answers_in_dev_builds() {
        assert_eq!(simulated_answer("[test:blocked] a cat"), Some(Simulated::Blocked));
        assert_eq!(simulated_answer("  [test:stream-error]"), Some(Simulated::StreamError));
        assert_eq!(simulated_answer("[test:partials] a cat"), Some(Simulated::Partials));
        assert_eq!(simulated_answer("a cat [test:blocked]"), None);
    }

    #[test]
    fn maps_http_errors_to_plain_messages() {
        assert!(describe_error(401, "").contains("API key"));
        assert!(describe_error(403, "").contains("verification"));
        let body = "{\"error\":{\"message\":\"Your request was rejected by the safety system\"}}";
        assert!(describe_error(400, body).starts_with("OpenAI's safety system"));
        assert!(describe_error(429, "").contains("rate limit"));
    }
}
