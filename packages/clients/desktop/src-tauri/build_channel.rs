//! The desktop's build channel, as the build script decides it (#1084).
//!
//! Shared by build.rs and the crate's unit tests (`#[path]`), so the rule the
//! build applies is the one the tests exercise.

use serde_json::{Map, Value};

/// The channel a `LASTERM_CHANNEL` value gives: exactly `release` is release,
/// anything else, absent included, is dev.
pub fn channel_from_value(value: Option<&str>) -> &'static str {
    if value == Some("release") {
        "release"
    } else {
        "dev"
    }
}

/// The Tauri identity of `channel`: identifier, product name, window title.
pub fn channel_identity(channel: &str) -> (&'static str, &'static str) {
    if channel == "release" {
        ("app.lasterm.desktop", "Lasterm")
    } else {
        ("app.lasterm.desktop.dev", "Lasterm Dev")
    }
}

/// The `TAURI_CONFIG` the build uses: whatever the Tauri CLI already set
/// (`cli`, from `--config`), with the channel's identifier, product name and
/// window titles merged in, the channel's keys winning and the CLI's others
/// kept. Tauri merges `TAURI_CONFIG` as a JSON Merge Patch, which replaces an
/// array whole, so the windows are given whole: the CLI's if it set them, else
/// `tauri.conf.json`'s (`base`), each with the channel's title.
pub fn merge_channel_config(
    cli: Option<&str>,
    base: &Value,
    channel: &str,
) -> Result<String, String> {
    let mut config = match cli.filter(|text| !text.trim().is_empty()) {
        Some(text) => serde_json::from_str::<Value>(text)
            .map_err(|error| format!("TAURI_CONFIG is not JSON: {error}"))?,
        None => Value::Object(Map::new()),
    };
    let object = config
        .as_object_mut()
        .ok_or_else(|| "TAURI_CONFIG is not a JSON object".to_string())?;
    let (identifier, product_name) = channel_identity(channel);

    let windows_from = |value: &Value| value.get("app").and_then(|app| app.get("windows")).cloned();
    let mut windows = windows_from(&Value::Object(object.clone()))
        .or_else(|| windows_from(base))
        .unwrap_or(Value::Array(Vec::new()));
    if let Some(list) = windows.as_array_mut() {
        for window in list.iter_mut().filter_map(Value::as_object_mut) {
            window.insert("title".into(), Value::String(product_name.into()));
        }
    }

    object.insert("identifier".into(), Value::String(identifier.into()));
    object.insert("productName".into(), Value::String(product_name.into()));
    let app = object
        .entry("app")
        .or_insert_with(|| Value::Object(Map::new()));
    let app = app
        .as_object_mut()
        .ok_or_else(|| "TAURI_CONFIG's app is not a JSON object".to_string())?;
    app.insert("windows".into(), windows);
    serde_json::to_string(&config).map_err(|error| error.to_string())
}
