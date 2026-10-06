use serde::Serialize;
use std::{collections::BTreeMap, time::Duration};

use crate::requests;

/**
 * Live price lists. OpenAI has no pricing API, but it publishes its official
 * price pages as Markdown. Image Sage reads the tables it needs from those
 * pages; when a page cannot be read, the app falls back to its built-in table
 * and says so.
 */
const OPENAI_PRICING_URL: &str = "https://developers.openai.com/api/docs/pricing.md";
/// The image guide page; its token calculator script holds the per-quality factors.
const OPENAI_GUIDE_URL: &str = "https://developers.openai.com/api/docs/guides/image-generation";
const OPENAI_SITE: &str = "https://developers.openai.com";
const CALCULATOR_SCRIPT_PREFIX: &str = "/_astro/GptImageTokenCalculator.react.";

/// OpenAI token rates for one image model, in US dollars per 1M tokens.
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct TokenRates {
    text_input: f64,
    image_input: f64,
    image_output: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceList {
    /// Rates by model id, such as `gpt-image-2.5-sunburst`.
    openai: BTreeMap<String, TokenRates>,
    /**
     * Token factors from OpenAI's calculator, by model family (`gpt-image-2`,
     * `gpt-image-2.5`) and quality. The app turns a factor and a size into
     * output tokens with the calculator's own formula.
     */
    openai_token_factors: BTreeMap<String, BTreeMap<String, f64>>,
    /// Plain messages for each page that could not be read.
    problems: Vec<String>,
}

fn money(cell: &str) -> Option<f64> {
    let cleaned: String = cell
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    cleaned.parse().ok()
}

fn cells(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().trim_matches('`').to_string())
        .collect()
}

/**
 * Reads the GPT Image rows of the "Model | Modality | Input | Cached input |
 * Output" tables. The page lists standard rates before batch rates, so the
 * first row seen for each model and modality is the standard rate.
 */
fn parse_openai(markdown: &str) -> BTreeMap<String, TokenRates> {
    let mut text = BTreeMap::new();
    let mut image = BTreeMap::new();
    let mut in_table = false;
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("| Model | Modality |") {
            in_table = true;
            continue;
        }
        if !in_table {
            continue;
        }
        if !trimmed.starts_with('|') {
            in_table = false;
            continue;
        }
        let row = cells(trimmed);
        if row.len() < 5 || !row[0].starts_with("gpt-image") {
            continue;
        }
        let input = money(&row[2]);
        let output = money(&row[4]);
        match row[1].to_ascii_lowercase().as_str() {
            "text" => {
                if let Some(input) = input {
                    text.entry(row[0].clone()).or_insert(input);
                }
            }
            "image" => {
                if let (Some(input), Some(output)) = (input, output) {
                    image.entry(row[0].clone()).or_insert((input, output));
                }
            }
            _ => {}
        }
    }
    image
        .into_iter()
        .filter_map(|(model, (image_input, image_output))| {
            let text_input = *text.get(&model)?;
            Some((
                model,
                TokenRates {
                    text_input,
                    image_input,
                    image_output,
                },
            ))
        })
        .collect()
}

/**
 * Reads the factor table from the calculator script, which looks like
 * `{"gpt-image-2":{low:16,medium:48,high:96},"gpt-image-2.5":{low:16,...}}`.
 */
fn parse_token_factors(script: &str) -> BTreeMap<String, BTreeMap<String, f64>> {
    let mut families = BTreeMap::new();
    let mut rest = script;
    while let Some(start) = rest.find("\"gpt-image-") {
        let after = &rest[start + 1..];
        let Some(name_end) = after.find('"') else {
            break;
        };
        let name = &after[..name_end];
        let body = &after[name_end + 1..];
        let Some(open) = body.strip_prefix(":{") else {
            rest = body;
            continue;
        };
        let Some(close) = open.find('}') else { break };
        let mut factors = BTreeMap::new();
        for pair in open[..close].split(',') {
            if let Some((key, value)) = pair.split_once(':') {
                let key = key.trim().trim_matches('"');
                if let Ok(value) = value.trim().parse::<f64>() {
                    factors.insert(key.to_string(), value);
                }
            }
        }
        if !factors.is_empty() {
            families.entry(name.to_string()).or_insert(factors);
        }
        rest = &open[close..];
    }
    families
}

/// Finds the calculator script in the guide page and reads its factors.
async fn fetch_token_factors(
    client: &reqwest::Client,
) -> Result<BTreeMap<String, BTreeMap<String, f64>>, String> {
    let page = fetch_text(client, OPENAI_GUIDE_URL).await?;
    let start = page
        .find(CALCULATOR_SCRIPT_PREFIX)
        .ok_or_else(|| "the token calculator is no longer on the image guide page".to_string())?;
    let end = page[start..]
        .find(|character: char| character == '"' || character == '&' || character.is_whitespace())
        .map(|offset| start + offset)
        .unwrap_or(page.len());
    let path = page[start..end].split('?').next().unwrap_or_default();
    if !path.ends_with(".js") {
        return Err("the token calculator script address is unreadable".into());
    }
    let script = fetch_text(client, &format!("{OPENAI_SITE}{path}")).await?;
    let factors = parse_token_factors(&script);
    if factors.is_empty() {
        return Err("the token calculator holds no readable factors".into());
    }
    Ok(factors)
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| requests::describe_transport_error("the price page", &error))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response
        .text()
        .await
        .map_err(|error| format!("unreadable page: {error}"))
}

#[tauri::command]
pub async fn fetch_prices() -> Result<PriceList, String> {
    let client = requests::client()?;
    let (openai_page, token_factors) = tokio::join!(
        fetch_text(&client, OPENAI_PRICING_URL),
        fetch_token_factors(&client)
    );
    let mut problems = Vec::new();
    let openai = match openai_page {
        Ok(page) => parse_openai(&page),
        Err(error) => {
            problems.push(format!("OpenAI price page: {error}"));
            BTreeMap::new()
        }
    };
    if openai.is_empty() && problems.is_empty() {
        problems.push(
            "OpenAI price page: no GPT Image prices found; the page layout may have changed."
                .into(),
        );
    }
    let openai_token_factors = match token_factors {
        Ok(factors) => factors,
        Err(error) => {
            problems.push(format!("OpenAI image calculator: {error}"));
            BTreeMap::new()
        }
    };
    Ok(PriceList {
        openai,
        openai_token_factors,
        problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENAI_SAMPLE: &str = "\
Standard

### Grouped Pricing Table data

| Model | Modality | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| gpt-image-2.5-sunburst | Image | $8.00 | $2.00 | $30.00 |
| gpt-image-2.5-sunburst | Text | $5.00 | $1.25 | - |
| gpt-image-2 | Image | $8.00 | $2.00 | $30.00 |
| gpt-image-2 | Text | $5.00 | $1.25 | - |

Batch

| Model | Modality | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| gpt-image-2 | Image | $4.00 | $1.00 | $15.00 |
| gpt-image-2 | Text | $2.50 | $0.625 | - |
";

    #[test]
    fn reads_standard_openai_rates_and_skips_batch() {
        let rates = parse_openai(OPENAI_SAMPLE);
        assert_eq!(rates.len(), 2);
        assert_eq!(
            rates["gpt-image-2"],
            TokenRates {
                text_input: 5.0,
                image_input: 8.0,
                image_output: 30.0
            }
        );
    }

    #[test]
    fn reads_calculator_token_factors() {
        let script = r#"var s=e(t(),1),c={"gpt-image-2":{low:16,medium:48,high:96},"gpt-image-2.5":{low:16,medium:24,high:48,xhigh:64,max:96}},l=[{label:`low`}]"#;
        let factors = parse_token_factors(script);
        assert_eq!(factors.len(), 2);
        assert_eq!(factors["gpt-image-2"]["high"], 96.0);
        assert_eq!(factors["gpt-image-2.5"]["xhigh"], 64.0);
    }

}

#[cfg(test)]
mod live {
    /// Run with `cargo test live_price_pages -- --ignored --nocapture` to check the real pages.
    #[tokio::test]
    #[ignore]
    async fn live_price_pages() {
        let prices = super::fetch_prices().await.unwrap();
        println!("openai: {:?}", prices.openai);
        println!("factors: {:?}", prices.openai_token_factors);
        println!("problems: {:?}", prices.problems);
        assert!(prices.problems.is_empty());
    }
}
