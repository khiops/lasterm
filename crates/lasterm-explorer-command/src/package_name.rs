// The desktop crate's package name, as `pack-msix.ps1` reads it from its
// Cargo.toml: the first line of `[package]` matching `name = "…"`, the value
// running to the next `"`. build.rs includes this file; its tests run here.

/// The `name` of the `[package]` table: a line that is `name`, blanks, `=`,
/// blanks and a quoted value, whatever follows the closing quote (a comment).
/// Any other form of the line is not read.
fn package_name(text: &str) -> Option<String> {
    // A byte order mark, which PowerShell's Get-Content drops too.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(table) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            in_package = table == "package";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some(rest) = line.strip_prefix("name") else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('"') else {
            continue;
        };
        if let Some((value, _)) = rest.split_once('"') {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::package_name;

    #[test]
    fn the_package_name_is_read_as_the_packager_reads_it() {
        let read = |text: &str| package_name(text);
        assert_eq!(
            read("[package]\nname = \"lasterm-desktop\" # desktop executable\n").as_deref(),
            Some("lasterm-desktop")
        );
        assert_eq!(
            read("[package]\nnamespace = \"x\"\nname=\"y\"\n").as_deref(),
            Some("y")
        );
        assert_eq!(
            read("[lib]\nname = \"lib\"\n[package]\nversion = \"1\"\nname = \"app\"\n").as_deref(),
            Some("app")
        );
        assert_eq!(
            read("\u{feff}[package]\nname = \"bom\"\n").as_deref(),
            Some("bom")
        );
        assert_eq!(read("[package]\nname = app\n"), None);
        assert_eq!(read("[package]\nname = \"\"\n"), None);
        assert_eq!(read("[dependencies]\nname = \"x\"\n"), None);
    }
}
