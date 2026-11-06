//! A PowerShell that says its directory on every prompt (#839).
//!
//! `Set-Location` moves PowerShell's location but not its process directory,
//! so the agent cannot read it (#834). A launch profile's `report_directory`
//! has the agent start the shell with `-NoExit -EncodedCommand <script>`: the
//! script runs after the user's `$PROFILE`, keeps the `prompt` that profile
//! defined, and has it write OSC 7 first, which [`crate::headless`] parses.
//! The script is the snippet the README gives for `$PROFILE`, byte for byte.

use crate::environment::Platform;

/// The script, as the README gives it for `$PROFILE`.
pub(crate) const SCRIPT: &str = include_str!("report-directory.ps1");

/// The arguments a shell starts with, once the hub has said whether its
/// launch profile reports the directory.
///
/// Only a Windows agent acts on it, only for a shell whose file name is `pwsh`
/// or `powershell` (with or without `.exe`, in any case), and only when every
/// argument is one PowerShell takes without running anything of its own
/// ([`runs_nothing`]). It then adds `-NoExit` (unless it is there) and
/// `-EncodedCommand` with [`SCRIPT`]: as Base64 data, it reaches the shell
/// whatever the quoting of the command line. Any other arguments are passed as
/// they are: a `-Command`, a `-File`, a script named on its own, an argument
/// this does not know.
pub fn report_directory_args(
    platform: Platform,
    shell: &str,
    mut args: Vec<String>,
    report_directory: bool,
) -> Vec<String> {
    if !report_directory || platform != Platform::Windows || !is_powershell(shell) {
        return args;
    }
    let Some(no_exit) = runs_nothing(&args) else {
        return args;
    };
    if !no_exit {
        args.push("-NoExit".to_owned());
    }
    args.push("-EncodedCommand".to_owned());
    args.push(encoded_command(SCRIPT));
    args
}

/// Whether `shell` names a PowerShell: Windows PowerShell or PowerShell 7.
fn is_powershell(shell: &str) -> bool {
    let name = shell.rsplit(['\\', '/']).next().unwrap_or(shell);
    let name = name.to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    matches!(stem, "pwsh" | "powershell")
}

/// What one of PowerShell's parameters is to this rule.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Parameter {
    /// A switch that runs nothing.
    Switch,
    /// `-NoExit`, which the script needs and need not be given twice.
    NoExit,
    /// A parameter that runs nothing, and takes the argument after it.
    Valued,
}

/// The parameters of `pwsh` and `powershell.exe` that run nothing: their
/// name, the shortest abbreviation PowerShell takes for it, and what it is.
/// Any other parameter is one this does not know to be harmless: `-Command`,
/// `-File`, `-EncodedCommand`, `-CommandWithArgs`, `-Version`, `-Help`, the
/// server modes, a session configuration.
const HARMLESS: &[(&str, &str, Parameter)] = &[
    ("noexit", "noe", Parameter::NoExit),
    ("nologo", "nol", Parameter::Switch),
    ("noprofile", "nop", Parameter::Switch),
    ("noprofileloadtime", "noprofileloadtime", Parameter::Switch),
    ("noninteractive", "noni", Parameter::Switch),
    ("interactive", "i", Parameter::Switch),
    ("login", "l", Parameter::Switch),
    ("sta", "sta", Parameter::Switch),
    ("mta", "mta", Parameter::Switch),
    ("executionpolicy", "ex", Parameter::Valued),
    ("ep", "ep", Parameter::Valued),
    ("windowstyle", "w", Parameter::Valued),
    ("workingdirectory", "wo", Parameter::Valued),
    ("wd", "wd", Parameter::Valued),
    ("inputformat", "inp", Parameter::Valued),
    ("if", "if", Parameter::Valued),
    ("outputformat", "o", Parameter::Valued),
    ("of", "of", Parameter::Valued),
    ("settingsfile", "settings", Parameter::Valued),
];

/// The parameter `arg` names, when it is one of [`HARMLESS`]: `-`, `--` or `/`
/// and a name or an abbreviation of it, in any case, as PowerShell reads them.
fn harmless(arg: &str) -> Option<Parameter> {
    let name = arg
        .strip_prefix("--")
        .or_else(|| arg.strip_prefix('-'))
        .or_else(|| arg.strip_prefix('/'))?
        .to_ascii_lowercase();
    HARMLESS
        .iter()
        .find(|(full, shortest, _)| full.starts_with(&name) && name.len() >= shortest.len())
        .map(|&(_, _, parameter)| parameter)
}

/// When every argument is one PowerShell takes without running anything of
/// its own, whether one of them is `-NoExit`; None otherwise. A parameter that
/// takes a value counts with the argument after it: without one, the shell
/// would refuse its command line, which is then left as it is.
fn runs_nothing(args: &[String]) -> Option<bool> {
    let mut no_exit = false;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match harmless(arg)? {
            Parameter::Switch => {}
            Parameter::NoExit => no_exit = true,
            Parameter::Valued => {
                args.next()?;
            }
        }
    }
    Some(no_exit)
}

/// `script` as `-EncodedCommand` takes it: the Base64 of its UTF-16LE bytes.
pub(crate) fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

/// Standard Base64, with padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let at = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let triple = (at(0) << 16) | (at(1) << 8) | at(2);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((triple >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PWSH: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";
    const POWERSHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    /// What the switch adds after the arguments it keeps.
    fn added(no_exit: bool) -> Vec<String> {
        let mut added = Vec::new();
        if no_exit {
            added.push("-NoExit".to_owned());
        }
        added.push("-EncodedCommand".to_owned());
        added.push(encoded_command(SCRIPT));
        added
    }

    /// Base64 back to bytes, to check the encoding from the other side.
    fn from_base64(text: &str) -> Vec<u8> {
        let value = |c: u8| {
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
                .iter()
                .position(|&a| a == c)
                .map(|p| p as u32)
        };
        let mut out = Vec::new();
        for quad in text.as_bytes().chunks(4) {
            let mut triple = 0u32;
            let mut len = 0;
            for (i, &c) in quad.iter().enumerate() {
                if c == b'=' {
                    break;
                }
                triple |= value(c).expect("a Base64 character") << (18 - 6 * i);
                len = i;
            }
            for i in 0..len {
                out.push((triple >> (16 - 8 * i)) as u8);
            }
        }
        out
    }

    #[test]
    fn a_powershell_with_no_arguments_reports_its_directory() {
        for shell in [
            PWSH,
            POWERSHELL,
            "pwsh",
            "pwsh.exe",
            "POWERSHELL.EXE",
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
            "C:/tools/PowerShell.exe",
        ] {
            assert_eq!(
                report_directory_args(Platform::Windows, shell, Vec::new(), true),
                added(true),
                "{shell}"
            );
        }
    }

    #[test]
    fn arguments_that_run_nothing_are_kept_before_the_script() {
        let args = strings(&[
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WorkingDirectory",
            "C:/src",
            "/nol",
            "--noni",
            "-WindowStyle",
            "Hidden",
            "-i",
            "-STA",
        ]);
        let mut expected = args.clone();
        expected.extend(added(true));
        assert_eq!(
            report_directory_args(Platform::Windows, PWSH, args, true),
            expected
        );
    }

    #[test]
    fn no_exit_is_given_once() {
        for no_exit in ["-NoExit", "-noe", "/NOEXIT", "--noexit"] {
            let args = strings(&["-NoLogo", no_exit]);
            let mut expected = args.clone();
            expected.extend(added(false));
            assert_eq!(
                report_directory_args(Platform::Windows, POWERSHELL, args, true),
                expected,
                "{no_exit}"
            );
        }
    }

    #[test]
    fn arguments_that_run_a_command_or_a_file_are_left_as_they_are() {
        for args in [
            &["-Command", "Get-Date"][..],
            &["-c", "ls"],
            &["-NoProfile", "-Com", "ls"],
            &["-File", "script.ps1"],
            &["-f", "script.ps1"],
            &["-EncodedCommand", "ZABpAHIA"],
            &["-e", "ZABpAHIA"],
            &["-ec", "ZABpAHIA"],
            &["-CommandWithArgs", "$args", "1"],
            &["-cwa", "$args", "1"],
            &["script.ps1"],
            &["-NoLogo", "C:/scripts/start.ps1"],
            &["-Version"],
            &["-v"],
            &["-?"],
            &["/?"],
            &["-Help"],
            &["-ConfigurationName", "JEA"],
            &["-ExecutionPolicy"],
            &["-no"],
            &["-"],
            &[""],
            &["-NoLogo:$true"],
            &["–NoLogo"],
        ] {
            let args = strings(args);
            assert_eq!(
                report_directory_args(Platform::Windows, PWSH, args.clone(), true),
                args
            );
        }
    }

    #[test]
    fn other_shells_are_started_as_asked() {
        for shell in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\tools\pwsh-preview.exe",
            r"C:\tools\mypowershell.exe",
            "nu.exe",
        ] {
            assert!(
                report_directory_args(Platform::Windows, shell, Vec::new(), true).is_empty(),
                "{shell}"
            );
        }
    }

    #[test]
    fn nothing_is_added_unless_the_hub_asks_or_on_unix() {
        assert!(report_directory_args(Platform::Windows, PWSH, Vec::new(), false).is_empty());
        for shell in ["/usr/bin/pwsh", "pwsh", PWSH] {
            assert!(
                report_directory_args(Platform::Unix, shell, Vec::new(), true).is_empty(),
                "{shell}"
            );
        }
    }

    #[test]
    fn the_encoded_command_is_the_script_in_utf16le_base64() {
        // What PowerShell's [Convert]::ToBase64String([Text.Encoding]::Unicode
        // .GetBytes(...)) gives for these.
        assert_eq!(
            encoded_command(r#"dir "c:\program files" "#),
            "ZABpAHIAIAAiAGMAOgBcAHAAcgBvAGcAcgBhAG0AIABmAGkAbABlAHMAIgAgAA=="
        );
        assert_eq!(encoded_command("é€😀"), "6QCsID3YAN4=");
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");

        let decoded = from_base64(&encoded_command(SCRIPT));
        let units: Vec<u16> = decoded
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), SCRIPT);
    }

    #[test]
    fn the_script_wraps_the_prompt_once_and_says_where_with_osc_7() {
        assert!(SCRIPT.contains("$function:global:prompt"), "{SCRIPT}");
        assert!(SCRIPT.contains("]7;file://"), "{SCRIPT}");
        // A second run, from `. $PROFILE` or from the switch over the snippet,
        // keeps the first wrapper: it finds its marker in the prompt.
        assert_eq!(SCRIPT.matches("lasterm-report-directory").count(), 2);
        // Windows PowerShell 5.1 has no `e escape.
        assert!(!SCRIPT.contains("`e"), "{SCRIPT}");
        // Well within a command line's 32,767 characters.
        assert!(encoded_command(SCRIPT).len() < 8192);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::cwd::ShellReport;
    use crate::headless::HeadlessMirror;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// What `powershell` prints running `script` from `-EncodedCommand`, as
    /// the switch passes it; None when this machine has no such PowerShell.
    fn run(powershell: &str, script: &str) -> Option<String> {
        let output = Command::new(powershell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
            ])
            .arg(encoded_command(script))
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        assert!(output.status.success(), "{powershell}: {output:?}");
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// What the agent reads in `output`.
    fn reported(output: &str) -> Option<ShellReport> {
        let mut mirror = HeadlessMirror::new(200, 10, 0);
        mirror.process(output.as_bytes());
        mirror.take_shell_cwd()
    }

    /// The script, run by a real PowerShell after a prompt theme of its own,
    /// and run twice, as `. $PROFILE` or the switch over the snippet would: the
    /// prompt writes one OSC 7 that the agent reads as this host's directory,
    /// then the theme's prompt, which still sees whether the command before it
    /// failed. A location off the file system says nothing.
    #[test]
    fn powershell_keeps_its_prompt_and_says_where_it_is() {
        let theme = "function global:prompt { \"THEME ok=$?> \" }";
        let script = format!(
            "{theme}\n{SCRIPT}\n{SCRIPT}\nSet-Location 'C:\\Program Files'\n\
             Get-Item C:\\lasterm-nowhere -ErrorAction SilentlyContinue\nprompt\n\
             Set-Location HKCU:\\\nprompt\n"
        );
        let mut ran = 0;
        for powershell in ["powershell.exe", "pwsh.exe"] {
            let Some(output) = run(powershell, &script) else {
                assert_eq!(
                    powershell, "pwsh.exe",
                    "Windows PowerShell is part of Windows"
                );
                continue;
            };
            ran += 1;
            let lines: Vec<&str> = output.lines().collect();
            assert_eq!(lines.len(), 2, "{powershell}: {output:?}");
            assert_eq!(lines[0].matches("\x1b]7;file://").count(), 1, "{output:?}");
            assert!(
                lines[0].starts_with("\x1b]7;file://")
                    && lines[0].ends_with("\x1b\\THEME ok=False> "),
                "{powershell}: {output:?}"
            );
            assert_eq!(
                reported(lines[0]),
                Some(ShellReport::Dir("C:\\Program Files".into())),
                "{powershell}: {output:?}"
            );
            assert_eq!(lines[1], "THEME ok=True> ", "{powershell}: {output:?}");
        }
        assert!(ran >= 1);
    }
}
