//! The decisions File Explorer's command and the desktop share (#1236). Plain
//! functions with no platform dependency: the desktop takes this module
//! without the COM class, and both refuse exactly the same folders.

/// The longest working directory, in UTF-16 units, Windows starts a process
/// in: `CreateProcessW` refuses 259 and more with `ERROR_DIRECTORY` (measured
/// on Windows 11 with `cmd.exe` and `powershell.exe`). The agent starts the
/// shell there, so a longer folder could never open.
pub const MAX_FOLDER_UNITS: usize = 258;

/// `LANG_FRENCH`, the primary language of every French LANGID.
const LANG_FRENCH: u16 = 0x0C;

/// `SFGAO_FILESYSTEM`: the item is part of the file system.
pub const SFGAO_FILESYSTEM: u32 = 0x4000_0000;
/// `SFGAO_FOLDER`: the item can hold items.
pub const SFGAO_FOLDER: u32 = 0x2000_0000;
/// `SFGAO_STREAM`: the item has a stream; a .zip is `FOLDER | STREAM`.
pub const SFGAO_STREAM: u32 = 0x0040_0000;

/// Whether `path` has the form a folder opened from File Explorer may have: a
/// drive letter, a colon and a backslash first; no control character; at most
/// [`MAX_FOLDER_UNITS`] UTF-16 units; and neither `${` nor `\\`, which the
/// agent expands or collapses in a working directory, so such a path would
/// reach the shell changed. The string is parsed here, never through
/// `std::path`, so the rule is the same on every platform.
pub fn lexically_acceptable(path: &str) -> bool {
    let mut chars = path.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(letter), Some(':'), Some('\\')) if letter.is_ascii_alphabetic() => {}
        _ => return false,
    }
    if path.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return false;
    }
    if path.encode_utf16().count() > MAX_FOLDER_UNITS {
        return false;
    }
    !(path.contains("${") || path.contains("\\\\"))
}

/// The entry's label for a Windows display language (a LANGID).
pub fn title_for_language(langid: u16) -> &'static str {
    if langid & 0x3ff == LANG_FRENCH {
        "Ouvrir dans lasterm"
    } else {
        "Open in lasterm"
    }
}

/// Whether File Explorer shows the entry for an item: a file-system folder that
/// is not a .zip, whose path (as Explorer gives it, UTF-16) is valid UTF-16 and
/// [`lexically_acceptable`].
pub fn offers_location(path: &[u16], attributes: u32) -> bool {
    attributes & SFGAO_FILESYSTEM != 0
        && attributes & SFGAO_FOLDER != 0
        && attributes & SFGAO_STREAM == 0
        && String::from_utf16(path).is_ok_and(|path| lexically_acceptable(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(path: &str) -> Vec<u16> {
        path.encode_utf16().collect()
    }

    const FOLDER: u32 = SFGAO_FILESYSTEM | SFGAO_FOLDER;

    /// A path of exactly `units` UTF-16 units, under `C:\`, ending in the
    /// two-unit character 😀 (one surrogate pair).
    fn path_ending_in_a_pair(units: usize) -> String {
        let mut path = String::from("C:\\");
        while path.encode_utf16().count() < units - 2 {
            path.push('a');
        }
        path.push('😀');
        assert_eq!(path.encode_utf16().count(), units);
        path
    }

    #[test]
    fn the_lexical_rule_refuses_every_other_form() {
        assert!(lexically_acceptable(
            "C:\\Users\\me\\My Projects\\dossier é 漢"
        ));
        assert!(lexically_acceptable("z:\\"));

        assert!(!lexically_acceptable("x\\y"), "relative");
        assert!(!lexically_acceptable("C:x"), "drive-relative");
        assert!(!lexically_acceptable("1:\\x"), "a digit for a drive");
        assert!(
            !lexically_acceptable("É:\\x"),
            "a non-ASCII letter for a drive"
        );
        assert!(!lexically_acceptable("\\\\server\\share\\x"), "UNC");
        assert!(!lexically_acceptable("\\\\?\\C:\\x"), "verbatim");
        assert!(!lexically_acceptable("C:\\a\\\\b"), "doubled backslash");
        assert!(!lexically_acceptable("C:\\w\\${X}"), "a variable reference");
        assert!(!lexically_acceptable("C:\\a\nb"), "a line feed");
        assert!(!lexically_acceptable("C:\\a\u{1}b"), "U+0001");
        assert!(!lexically_acceptable("C:\\a\tb"), "a tab");
        assert!(!lexically_acceptable("C:\\a\u{7f}b"), "DEL");

        assert!(lexically_acceptable(&path_ending_in_a_pair(258)));
        assert!(!lexically_acceptable(&path_ending_in_a_pair(259)));
    }

    #[test]
    fn title_follows_the_display_language() {
        assert_eq!(title_for_language(0x040C), "Ouvrir dans lasterm");
        assert_eq!(title_for_language(0x0C0C), "Ouvrir dans lasterm");
        assert_eq!(title_for_language(0x0409), "Open in lasterm");
        assert_eq!(title_for_language(0x0407), "Open in lasterm");
    }

    #[test]
    fn only_drive_letter_file_system_folders_are_offered() {
        assert!(offers_location(&wide("C:\\x y"), FOLDER));
        assert!(offers_location(&wide("Z:\\"), FOLDER));

        let mut lone = wide("C:\\");
        lone.push(0xD800);
        assert!(!offers_location(&lone, FOLDER), "a lone surrogate");
        assert!(!offers_location(&wide("\\\\server\\share"), FOLDER));
        assert!(!offers_location(&wide("\\\\wsl.localhost\\U\\h"), FOLDER));
        assert!(!offers_location(&wide("\\\\?\\C:\\x"), FOLDER));
        assert!(!offers_location(&wide("C:relative"), FOLDER));
        assert!(!offers_location(&wide("C:\\work\\${X}"), FOLDER));
        assert!(!offers_location(&wide("C:\\a\\\\b"), FOLDER));
        assert!(
            !offers_location(&wide("C:\\x"), FOLDER | SFGAO_STREAM),
            "a .zip"
        );
        assert!(!offers_location(&wide("C:\\x"), SFGAO_FILESYSTEM), "a file");
        assert!(
            !offers_location(&wide("C:\\x"), SFGAO_FOLDER),
            "not in the file system"
        );
    }
}
