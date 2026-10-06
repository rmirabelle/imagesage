use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};

/**
 * What Image Sage was charged per local day ("2026-10-05": dollars), kept in
 * a file in the app's local data folder. The web view's own storage is
 * separate for the dev app and the installed app, so the totals live here,
 * where both see them and an update cannot lose them.
 */
type SpendByDay = BTreeMap<String, f64>;

/** One change at a time, so two charges that finish together are both kept. */
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn spend_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not find the app data folder: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create the app data folder: {error}"))?;
    Ok(dir.join("spend.json"))
}

/// Adds `add` to the record and drops days before `oldest`; returns the whole record.
fn merge(mut record: SpendByDay, add: &SpendByDay, oldest: &str) -> SpendByDay {
    for (day, usd) in add {
        if usd.is_finite() && *usd > 0.0 {
            *record.entry(day.clone()).or_insert(0.0) += usd;
        }
    }
    record.retain(|day, usd| day.as_str() >= oldest && usd.is_finite());
    record
}

/**
 * Adds charges (`add`, by day; empty only reads) to the saved record, drops
 * days before `oldest`, and returns the record. A damaged file starts over
 * rather than blocking new charges.
 */
#[tauri::command]
pub fn spend_record(app: AppHandle, add: SpendByDay, oldest: String) -> Result<SpendByDay, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "The spend record is busy. Try again.".to_string())?;
    let path = spend_path(&app)?;
    let saved: SpendByDay = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let record = merge(saved, &add, &oldest);
    if !add.is_empty() {
        let text = serde_json::to_string_pretty(&record).map_err(|error| format!("Could not save the spend record: {error}"))?;
        let partial = path.with_extension("json.part");
        std::fs::write(&partial, text).map_err(|error| format!("Could not save the spend record: {error}"))?;
        std::fs::rename(&partial, &path).map_err(|error| format!("Could not save the spend record: {error}"))?;
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_adds_charges_and_drops_old_days() {
        let saved = SpendByDay::from([("2026-08-01".into(), 1.0), ("2026-10-05".into(), 0.5)]);
        let add = SpendByDay::from([("2026-10-05".into(), 0.25), ("2026-10-06".into(), 0.1), ("2026-10-07".into(), -3.0)]);
        let record = merge(saved, &add, "2026-08-05");
        assert_eq!(record, SpendByDay::from([("2026-10-05".into(), 0.75), ("2026-10-06".into(), 0.1)]));
    }
}
