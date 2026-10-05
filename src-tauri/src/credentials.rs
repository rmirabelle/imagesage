use serde::Deserialize;

/**
 * API keys live in Windows Credential Manager, one entry per provider. A key is
 * never returned to the webview after entry; the frontend only learns whether
 * a key exists and a short masked hint.
 */
const SERVICE: &str = "ImageSage";

/// Which service a key belongs to: OpenAI creates new images and makes every edit.
#[derive(Clone, Copy, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[serde(rename = "openai")]
    OpenAi,
}

impl Provider {
    fn account(self) -> &'static str {
        match self {
            Provider::OpenAi => "openai-api-key",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Provider::OpenAi => "OpenAI",
        }
    }
}

fn entry(provider: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider.account())
        .map_err(|error| format!("Windows Credential Manager is unavailable: {error}"))
}

/// The stored key, or a plain message that tells the user to connect first.
pub fn api_key(provider: Provider) -> Result<String, String> {
    match entry(provider)?.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(key),
        Ok(_) | Err(keyring::Error::NoEntry) => Err(format!(
            "ImageSage is not connected to {}. Add your API key in Settings.",
            provider.label()
        )),
        Err(error) => Err(format!("Could not read the saved API key: {error}")),
    }
}

pub fn validate_key_shape(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("Paste your API key.".into());
    }
    if key.chars().any(char::is_whitespace) || key.len() < 20 {
        return Err("That does not look like an API key.".into());
    }
    Ok(())
}

/**
 * The start and end of a key, so the user can tell keys apart. A real OpenAI
 * key shows its first 12 and last 8 characters; a short key shows at most a
 * quarter of its length at each end, so most of it stays hidden.
 */
fn hint(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let quarter = chars.len() / 4;
    let head: String = chars[..quarter.min(12)].iter().collect();
    let tail: String = chars[chars.len() - quarter.min(8)..].iter().collect();
    format!("{head}…{tail}")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    connected: bool,
    hint: Option<String>,
}

#[tauri::command]
pub fn api_key_status(provider: Provider) -> ApiKeyStatus {
    match api_key(provider) {
        Ok(key) => ApiKeyStatus {
            connected: true,
            hint: Some(hint(&key)),
        },
        Err(_) => ApiKeyStatus {
            connected: false,
            hint: None,
        },
    }
}

#[tauri::command]
pub fn set_api_key(provider: Provider, key: String) -> Result<ApiKeyStatus, String> {
    let key = key.trim();
    validate_key_shape(key)?;
    entry(provider)?
        .set_password(key)
        .map_err(|error| format!("Could not save the API key: {error}"))?;
    Ok(api_key_status(provider))
}

#[tauri::command]
pub fn clear_api_key(provider: Provider) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove the API key: {error}")),
    }
}

/// Checks a key (the given one, or the saved one) and returns a short success message.
/// The page where users create and manage their OpenAI API keys.
const OPENAI_API_KEYS_URL: &str = "https://platform.openai.com/api-keys";

/**
 * Opens the OpenAI API keys page in the default browser. The URL is fixed
 * here, so the webview cannot use this command to open any other address.
 */
#[tauri::command]
pub fn open_api_keys_page() -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(OPENAI_API_KEYS_URL)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the browser: {error}"))
}

#[tauri::command]
pub async fn test_api_key(
    provider: Provider,
    key: Option<String>,
    model: String,
) -> Result<String, String> {
    let key = match key {
        Some(key) => {
            let key = key.trim().to_string();
            validate_key_shape(&key)?;
            key
        }
        None => api_key(provider)?,
    };
    match provider {
        Provider::OpenAi => crate::openai::test_key(key, &model).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_shows_only_the_ends_of_the_key() {
        assert_eq!(hint("sk-proj-abcdefghijklmnop1234"), "sk-proj…nop1234");
        let long = format!("sk-proj-ABCD{}wxyz5678", "x".repeat(140));
        assert_eq!(hint(&long), "sk-proj-ABCD…wxyz5678");
    }

    #[test]
    fn rejects_keys_with_whitespace_or_too_short() {
        assert!(validate_key_shape("").is_err());
        assert!(validate_key_shape("sk-short").is_err());
        assert!(validate_key_shape("sk-proj-abc def-ghijklmnopqrstu").is_err());
        assert!(validate_key_shape("sk-proj-abcdefghijklmnopqrstu").is_ok());
    }

    #[test]
    fn parses_provider_names_from_the_frontend() {
        assert_eq!(
            serde_json::from_str::<Provider>("\"openai\"").unwrap(),
            Provider::OpenAi
        );
        assert!(serde_json::from_str::<Provider>("\"flux\"").is_err());
    }
}
