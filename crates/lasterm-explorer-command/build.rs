//! The name of the executable `Invoke` starts: the desktop crate's package
//! name, which `pack-msix.ps1` also stages the desktop under. Both read it from
//! the line `name = "…"` of `[package]` the same way, case-sensitively
//! (src/package_name.rs).

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

include!("src/package_name.rs");
