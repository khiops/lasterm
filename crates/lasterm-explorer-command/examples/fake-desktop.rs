//! Stands in for `lasterm-desktop.exe` in tests/com.rs.
//!
//! Writes its arguments, one per line, then its current directory, to the file
//! `LASTERM_FAKE_DESKTOP_RECORD` names, then waits until the file
//! `LASTERM_FAKE_DESKTOP_RELEASE` names exists (at most 30 s), so the test can
//! tell that `Invoke` returned while it was still running. It also appends its
//! second argument, one line per start, to the file
//! `LASTERM_FAKE_DESKTOP_LAUNCHES` names, so the test can count the starts.

use std::time::{Duration, Instant};

fn main() {
    let Some(record) = std::env::var_os("LASTERM_FAKE_DESKTOP_RECORD") else {
        return;
    };
    if let Some(launches) = std::env::var_os("LASTERM_FAKE_DESKTOP_LAUNCHES") {
        use std::io::Write;
        let folder = std::env::args().nth(2).unwrap_or_default();
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(launches)
        {
            let _ = writeln!(log, "{folder}");
        }
    }
    let mut text = String::new();
    for argument in std::env::args().skip(1) {
        text.push_str(&argument);
        text.push('\n');
    }
    let directory = std::env::current_dir().map(|path| path.display().to_string());
    text.push_str(&directory.unwrap_or_default());
    text.push('\n');
    let partial = std::path::PathBuf::from(&record).with_extension("partial");
    if std::fs::write(&partial, text).is_err() || std::fs::rename(&partial, &record).is_err() {
        return;
    }
    let Some(release) = std::env::var_os("LASTERM_FAKE_DESKTOP_RELEASE") else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline && !std::path::Path::new(&release).exists() {
        std::thread::sleep(Duration::from_millis(50));
    }
}
