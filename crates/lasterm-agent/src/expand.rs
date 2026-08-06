use std::collections::HashMap;

/// Expand `${VAR}` references in a string using the provided env map
/// and falling back to process env.
///
/// Rules:
/// - `${VAR}` → env[VAR] or std::env::var(VAR), keep literal if not found
/// - `\${VAR}` → literal `${VAR}` (backslash consumed)
/// - `\\${VAR}` → literal `\` + expanded value
/// - `$VAR` (no braces) → NOT expanded
/// - One-pass only: expanded values are NOT re-scanned (no recursion)
/// - On Windows (cfg): case-insensitive env key lookup
pub fn expand_vars(input: &str, env: Option<&HashMap<String, String>>) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < len {
        if bytes[i] == b'\\' {
            if i + 1 < len && bytes[i + 1] == b'\\' {
                if i + 2 < len && bytes[i + 2] == b'$' && i + 3 < len && bytes[i + 3] == b'{' {
                    // `\\${VAR}` => literal `\` + expanded VAR
                    out.push('\\');
                    i += 2;
                    continue;
                }
                out.push('\\');
                i += 2;
                continue;
            } else if i + 1 < len && bytes[i + 1] == b'$' && i + 2 < len && bytes[i + 2] == b'{' {
                // `\${VAR}` => literal `${VAR}`
                if let Some(close) = find_closing_brace(bytes, i + 3) {
                    out.push_str(&input[i + 1..=close]);
                    i = close + 1;
                    continue;
                }
                out.push('\\');
                i += 1;
                continue;
            } else {
                out.push('\\');
                i += 1;
                continue;
            }
        }

        if bytes[i] == b'$' && i + 1 < len && bytes[i + 1] == b'{' {
            if let Some(close) = find_closing_brace(bytes, i + 2) {
                let var_name = &input[i + 2..close];
                match lookup_var(var_name, env) {
                    Some(v) => out.push_str(&v),
                    None => out.push_str(&input[i..=close]),
                }
                i = close + 1;
                continue;
            }
        }

        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

fn find_closing_brace(bytes: &[u8], start: usize) -> Option<usize> {
    bytes[start..]
        .iter()
        .position(|&b| b == b'}')
        .map(|pos| start + pos)
}

fn lookup_var(name: &str, env: Option<&HashMap<String, String>>) -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(map) = env {
            let lower = name.to_lowercase();
            if let Some((_, v)) = map.iter().find(|(k, _)| k.to_lowercase() == lower) {
                return Some(v.clone());
            }
        }
        let lower = name.to_lowercase();
        std::env::vars()
            .find(|(k, _)| k.to_lowercase() == lower)
            .map(|(_, v)| v)
    }

    #[cfg(not(windows))]
    {
        if let Some(map) = env {
            if let Some(v) = map.get(name) {
                return Some(v.clone());
            }
        }
        std::env::var(name).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn test_expand_simple() {
        let e = env(&[("HOME", "/home/user")]);
        assert_eq!(expand_vars("${HOME}/bin", Some(&e)), "/home/user/bin");
    }

    #[test]
    fn test_expand_escaped() {
        let e = env(&[("HOME", "/home/user")]);
        assert_eq!(expand_vars("\\${HOME}", Some(&e)), "${HOME}");
    }

    #[test]
    fn test_expand_double_escaped() {
        let e = env(&[("HOME", "/home/user")]);
        assert_eq!(expand_vars("\\\\${HOME}", Some(&e)), "\\/home/user");
    }

    #[test]
    fn test_expand_undefined_kept() {
        let e = env(&[]);
        assert_eq!(
            expand_vars("${UNDEFINED_LASTERM_TEST_VAR_XYZ}", Some(&e)),
            "${UNDEFINED_LASTERM_TEST_VAR_XYZ}"
        );
    }

    #[test]
    fn test_expand_no_recursion() {
        let e = env(&[("INJECT", "${HOME}"), ("HOME", "/home/user")]);
        assert_eq!(expand_vars("${INJECT}", Some(&e)), "${HOME}");
    }

    #[test]
    fn test_expand_empty() {
        assert_eq!(expand_vars("", None), "");
    }

    #[test]
    fn test_expand_no_braces_not_expanded() {
        let e = env(&[("VAR", "value")]);
        assert_eq!(expand_vars("$VAR", Some(&e)), "$VAR");
    }

    #[test]
    fn test_expand_multiple_vars() {
        let e = env(&[("USER", "alice"), ("HOST", "server1")]);
        assert_eq!(expand_vars("${USER}@${HOST}", Some(&e)), "alice@server1");
    }
}
