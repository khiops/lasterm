//! What a terminal must not pass on to the shells it hosts.
//!
//! `NO_COLOR` says "do not colour **your** output" to the program that reads
//! it. An agent inherits it from whatever started the chain above it — a shell,
//! an IDE, a CI runner — and hands its whole environment to every PTY it
//! spawns, so that preference reached programs the user runs *inside* a
//! terminal and took the colour out of their prompt, their `ls`, their editor.
//! Nobody asked those for plain output; the variable was addressed to another
//! program entirely.
//!
//! A terminal that wants no colour in its own output is a separate matter, and
//! a user who wants a colourless shell can still say so per profile, where the
//! channel's own environment is set.

/// The variables a terminal keeps to itself rather than hand to its shells.
pub const VETOED_INHERITED: &[&str] = &["NO_COLOR"];

/// Drop them, reporting what was actually there to drop.
///
/// Takes its reader and remover so the decision can be tested without the
/// process environment, which every other test shares.
pub fn strip_inherited<P, R>(present: P, mut remove: R) -> Vec<&'static str>
where
    P: Fn(&str) -> bool,
    R: FnMut(&str),
{
    let mut stripped = Vec::new();
    for name in VETOED_INHERITED {
        if present(name) {
            remove(name);
            stripped.push(*name);
        }
    }
    stripped
}

/// Drop them from this process, so no shell it spawns inherits them.
///
/// Call this before the process has threads. The PTY spawn reads the same
/// environment to build each child's, and changing it under a running runtime
/// is unsound — `std::env::remove_var` is `unsafe` from the 2024 edition for
/// that reason. Done from inside the runtime, the agent wedged: it accepted
/// connections and answered no SPAWN.
pub fn strip_inherited_from_process() -> Vec<&'static str> {
    strip_inherited(
        |name| std::env::var_os(name).is_some(),
        |name| std::env::remove_var(name),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn takes_no_color_out_of_what_a_shell_inherits() {
        let removed = RefCell::new(Vec::new());

        let stripped = strip_inherited(
            |name| name == "NO_COLOR",
            |name| removed.borrow_mut().push(name.to_string()),
        );

        assert_eq!(stripped, vec!["NO_COLOR"]);
        assert_eq!(*removed.borrow(), vec!["NO_COLOR".to_string()]);
    }

    #[test]
    fn removes_nothing_that_was_not_there() {
        let removed = RefCell::new(Vec::new());

        let stripped = strip_inherited(
            |_| false,
            |name| removed.borrow_mut().push(name.to_string()),
        );

        assert!(stripped.is_empty());
        assert!(removed.borrow().is_empty());
    }

    // TERM is how a shell learns what it is talking to, and COLORTERM how it
    // learns what that can show: taking either would be the opposite of this.
    #[test]
    fn keeps_what_tells_a_shell_about_its_terminal() {
        for name in ["TERM", "COLORTERM", "TERM_PROGRAM", "FORCE_COLOR"] {
            assert!(
                !VETOED_INHERITED.contains(&name),
                "{name} must be inherited"
            );
        }
    }
}
