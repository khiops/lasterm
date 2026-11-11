use std::path::PathBuf;

/// The Windows manifest of the binaries this crate links: the executable, which
/// tauri-build embeds it in, and the unit tests, which load Tauri's app too. It
/// names Common Controls 6. This is tauri-build's own default, kept here so that
/// both read one file.
const WINDOWS_MANIFEST: &str = include_str!("windows-app-manifest.xml");

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        write_test_manifest();
    }
    let windows = tauri_build::WindowsAttributes::new().app_manifest(WINDOWS_MANIFEST);
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("{error:#}");
    }
}

/// The tests drive commands through Tauri's mock runtime, whose menu code
/// imports TaskDialogIndirect from Common Controls 6. Windows loads a binary
/// importing it only under a manifest naming that version, and tauri-build
/// embeds its own in the executable alone (`rustc-link-arg-bins`; Cargo's
/// `rustc-link-arg-tests` reaches `tests/` targets only, not the unit tests).
///
/// So this writes WINDOWS_MANIFEST as a compiled resource file, which link.exe
/// takes as such whatever its name. Named `.lib`, it is what the
/// `#[cfg(test)] #[link]` in lib.rs names: the unit tests' binary links it,
/// and nothing else does.
fn write_test_manifest() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let mut res = Vec::new();
    // A resource file opens with an empty entry; then RT_MANIFEST (24), ID 1.
    resource_entry(&mut res, 0, 0, 0, &[]);
    resource_entry(&mut res, 24, 1, 0x0409, WINDOWS_MANIFEST.as_bytes());
    #[expect(
        clippy::disallowed_methods,
        reason = "the build's own output directory, which holds no protected file"
    )]
    std::fs::write(out_dir.join("lasterm_test_manifest.lib"), res)
        .expect("write the unit tests' manifest");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
}

/// One entry of a resource file: its header, with a numeric type and name,
/// then its data, padded to four bytes.
fn resource_entry(res: &mut Vec<u8>, kind: u16, name: u16, language: u16, data: &[u8]) {
    let data_size = u32::try_from(data.len()).expect("a resource under 4 GiB");
    res.extend_from_slice(&data_size.to_le_bytes());
    res.extend_from_slice(&32u32.to_le_bytes()); // header size
    res.extend_from_slice(&[0xff, 0xff]);
    res.extend_from_slice(&kind.to_le_bytes());
    res.extend_from_slice(&[0xff, 0xff]);
    res.extend_from_slice(&name.to_le_bytes());
    res.extend_from_slice(&0u32.to_le_bytes()); // data version
    let memory_flags: u16 = if data.is_empty() { 0 } else { 0x0030 }; // moveable, pure
    res.extend_from_slice(&memory_flags.to_le_bytes());
    res.extend_from_slice(&language.to_le_bytes());
    res.extend_from_slice(&0u32.to_le_bytes()); // version
    res.extend_from_slice(&0u32.to_le_bytes()); // characteristics
    res.extend_from_slice(data);
    res.resize(res.len().next_multiple_of(4), 0);
}
