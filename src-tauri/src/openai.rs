use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::credentials::{self, Provider};
use crate::requests::{self, AiImage, AiRequests, ProgressReporter};

const SERVICE: &str = "OpenAI";
const API_BASE: &str = "https://api.openai.com/v1";
const PARTIAL_IMAGES: u8 = 2;

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
    } else if kind == "error" || value.get("error").is_some() {
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

async fn stream_image(
    reporter: ProgressReporter,
    builder: reqwest::RequestBuilder,
) -> Result<AiImage, String> {
    reporter.stage("sending");
    let response = builder
        .send()
        .await
        .map_err(|error| transport_error(&error))?;
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
    while let Some(chunk) = stream.next().await {
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
                StreamEvent::Partial { index, b64 } => reporter.partial(index, png_data_url(&b64)),
                StreamEvent::Completed { b64, usage } => {
                    reporter.stage("finishing");
                    return Ok(AiImage {
                        data_url: png_data_url(&b64),
                        usage,
                    });
                }
                StreamEvent::Failed(message) => return Err(message),
                StreamEvent::Ignored => {}
            }
        }
    }
    Err("The connection closed before OpenAI finished the image.".into())
}

#[tauri::command]
pub async fn ai_generate(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: GenerateRequest,
) -> Result<AiImage, String> {
    let key = credentials::api_key(Provider::OpenAi)?;
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
    let builder = requests::client()?
        .post(format!("{API_BASE}/images/generations"))
        .bearer_auth(key)
        .json(&body);
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| {
        stream_image(reporter, builder)
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
    /// "transparent" asks for a PNG with a see-through background.
    #[serde(default)]
    background: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedEditRequest {
    #[serde(flatten)]
    edit: WholeEditRequest,
    mask_png: String,
}

fn png_part(data_url: &str, label: &str, file_name: &'static str) -> Result<reqwest::multipart::Part, String> {
    reqwest::multipart::Part::bytes(requests::decode_png(data_url, label)?)
        .file_name(file_name)
        .mime_str("image/png")
        .map_err(|error| format!("Could not prepare the upload: {error}"))
}

/// Sends an Images API edit; the mask, when given, marks the area GPT Image may change.
async fn run_edit(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: WholeEditRequest,
    mask_png: Option<String>,
) -> Result<AiImage, String> {
    let key = credentials::api_key(Provider::OpenAi)?;
    let part = png_part(&request.image_png, "image", "image.png")?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", request.model)
        .text("prompt", request.prompt)
        .text("size", request.size)
        .text("quality", request.quality)
        .text("output_format", "png")
        .text("n", "1")
        .text("stream", "true")
        .text("partial_images", PARTIAL_IMAGES.to_string())
        .part("image", part);
    if let Some(background) = request.background {
        form = form.text("background", background);
    }
    if let Some(mask) = mask_png {
        form = form.part("mask", png_part(&mask, "mask", "mask.png")?);
    }
    let builder = requests::client()?
        .post(format!("{API_BASE}/images/edits"))
        .bearer_auth(key)
        .multipart(form);
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| {
        stream_image(reporter, builder)
    })
    .await
}

/// Edits an image with GPT Image through the Images API edit endpoint, without a mask:
/// the whole image, or a region for a transparent overlay.
#[tauri::command]
pub async fn ai_edit_whole(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: WholeEditRequest,
) -> Result<AiImage, String> {
    run_edit(app, requests, request, None).await
}

/// Edits a square region with GPT Image; the mask's transparent pixels mark the area to change.
#[tauri::command]
pub async fn ai_edit_masked(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: MaskedEditRequest,
) -> Result<AiImage, String> {
    run_edit(app, requests, request.edit, Some(request.mask_png)).await
}

/// The vision model that describes a region before a FLUX edit.
const DESCRIBE_MODEL: &str = "gpt-5-mini";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeRequest {
    request_id: String,
    instruction: String,
    /// The edit box as `[top, left, bottom, right]` on a 0–1000 scale.
    edit_box: [u16; 4],
    image_png: String,
}

/// A scene description for a FLUX 3 Image layout prompt.
#[derive(serde::Serialize, Deserialize)]
pub struct SceneDescription {
    caption: String,
    anchors: Vec<SceneAnchor>,
}

#[derive(serde::Serialize, Deserialize)]
pub struct SceneAnchor {
    id: String,
    bbox: Vec<i64>,
    desc: String,
}

fn describe_instructions(instruction: &str, edit_box: [u16; 4]) -> String {
    let [top, left, bottom, right] = edit_box;
    format!(
        "You prepare an image edit for the FLUX 3 Image model. The image is a crop of a larger picture. \
The edit box is [{top}, {left}, {bottom}, {right}] as [top, left, bottom, right] on a 0-1000 scale from the top-left corner. \
The edit instruction for the box is: \"{instruction}\".\n\
Return JSON with two fields.\n\
caption: one paragraph of 60 to 120 words that describes the whole image as it will look after the edit: the scene, the main elements and where they are, materials, colors, lighting, time of day, camera view, and style.\n\
anchors: 4 to 6 important elements that must stay unchanged. Choose elements outside the edit box or crossing its border, nearest to the box first. \
Do not list anything the instruction changes. For each anchor give id (short snake_case, for example cabin_1), \
bbox ([top, left, bottom, right] on the 0-1000 scale, tightly around the element), and desc (one or two sentences: what it is, material, color, lighting, and where it is relative to the edit box)."
    )
}

/// The first `output_text` of a Responses API answer.
fn response_text(value: &Value) -> Option<&str> {
    value
        .get("output")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .find(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .and_then(|part| part.get("text").and_then(Value::as_str))
}

/// Describes the sent region and the elements around the edit box, for a FLUX layout prompt.
#[tauri::command]
pub async fn describe_scene(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: DescribeRequest,
) -> Result<SceneDescription, String> {
    let key = credentials::api_key(Provider::OpenAi)?;
    requests::decode_png(&request.image_png, "image")?;
    let anchor_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "bbox", "desc"],
        "properties": {
            "id": { "type": "string" },
            "bbox": { "type": "array", "items": { "type": "integer" } },
            "desc": { "type": "string" }
        }
    });
    let body = json!({
        "model": DESCRIBE_MODEL,
        "reasoning": { "effort": "low" },
        "input": [{
            "role": "user",
            "content": [
                { "type": "input_text", "text": describe_instructions(&request.instruction, request.edit_box) },
                { "type": "input_image", "image_url": request.image_png }
            ]
        }],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "scene_description",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["caption", "anchors"],
                    "properties": {
                        "caption": { "type": "string" },
                        "anchors": { "type": "array", "items": anchor_schema }
                    }
                }
            }
        }
    });
    let builder = requests::client()?
        .post(format!("{API_BASE}/responses"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(120))
        .json(&body);
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| async move {
        reporter.stage("describing");
        let response = builder.send().await.map_err(|error| transport_error(&error))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(describe_error(status.as_u16(), &body));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("OpenAI sent an unreadable answer: {error}"))?;
        let text = response_text(&value).ok_or_else(|| "OpenAI did not return a scene description.".to_string())?;
        serde_json::from_str(text).map_err(|error| format!("OpenAI returned an unreadable scene description: {error}"))
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
