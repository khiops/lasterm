//! The name of the executable `Invoke` starts: the desktop crate's package
//! name, which `pack-msix.ps1` also stages the desktop under, so the two cannot
//! drift apart.

use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/clients/desktop/src-tauri/Cargo.toml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = std::fs::read_to_string(&manifest)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", manifest.display()));
    let name = package_name(&text)
        .unwrap_or_else(|| panic!("no [package] name in {}", manifest.display()));
    println!("cargo:rustc-env=LASTERM_DESKTOP_EXE={name}.exe");
}

/// The `name` of the `[package]` table, read line by line as `pack-msix.ps1`
/// reads it.
fn package_name(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package {
            if let Some(value) = line.strip_prefix("name") {
                let value = value.trim_start().strip_prefix('=')?.trim();
                return Some(value.trim_matches('"').to_string());
            }
        }
    }
    None
}
