//! Which hub a terminal belongs to (#127).
//!
//! A daemon serves several hubs at once, and every channel has exactly one
//! owner: the hub whose connection spawned it. A hub names itself with the key
//! it sends in AUTH; the agent keeps only the SHA-256 of that key, and a hub
//! that sends none belongs to the one `legacy` owner.

use std::sync::Arc;

use sha2::{Digest, Sha256};

/// The owner a connection without a hub key belongs to. No SHA-256 in hex is
/// six characters long, so it names no hub key.
const LEGACY: &str = "legacy";

/// Who a channel belongs to: the lowercase hex SHA-256 of a hub's key, or
/// `legacy`.
///
/// Equality is constant-time. It is cheap to clone: every item a channel sends
/// towards the hub carries one.
#[derive(Clone)]
pub(crate) struct OwnerId(Arc<str>);

impl OwnerId {
    /// The owner shared by every connection that presents no hub key: today's
    /// hubs, and the single connection of stdio mode.
    pub(crate) fn legacy() -> Self {
        Self(Arc::from(LEGACY))
    }

    /// The owner a hub key names. The key itself is never kept.
    pub(crate) fn from_hub_key(hub_key: &str) -> Self {
        let digest = Sha256::digest(hub_key.as_bytes());
        let mut hex = String::with_capacity(digest.len() * 2);
        for byte in digest.iter() {
            hex.push(char::from_digit(u32::from(byte >> 4), 16).expect("a nibble is a hex digit"));
            hex.push(
                char::from_digit(u32::from(byte & 0x0f), 16).expect("a nibble is a hex digit"),
            );
        }
        Self(Arc::from(hex))
    }

    /// The owner an AUTH frame names: its key's, or `legacy` without one. An
    /// empty key names nothing, so it counts as none.
    pub(crate) fn from_auth(hub_key: Option<&str>) -> Self {
        match hub_key {
            Some(key) if !key.is_empty() => Self::from_hub_key(key),
            _ => Self::legacy(),
        }
    }

    /// What a log line may show of an owner: at most its first 8 characters.
    pub(crate) fn short(&self) -> &str {
        let end = self.0.len().min(8);
        &self.0[..end]
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl PartialEq for OwnerId {
    fn eq(&self, other: &Self) -> bool {
        ct_eq(self.0.as_bytes(), other.0.as_bytes())
    }
}

impl Eq for OwnerId {}

impl std::hash::Hash for OwnerId {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

/// Only the short form, so that no log or panic message carries a whole id.
impl std::fmt::Debug for OwnerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OwnerId({})", self.short())
    }
}

/// Constant-time byte comparison — prevents timing attacks on token and owner
/// comparison. Only the length is compared in variable time.
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owner id is the SHA-256 of the key, in lowercase hex: the hub side
    /// computes nothing, but anyone reading a log compares against this.
    #[test]
    fn an_owner_id_is_the_lowercase_hex_sha256_of_the_hub_key() {
        // FIPS 180-2, appendix B.1.
        assert_eq!(
            OwnerId::from_hub_key("abc").as_str(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_connection_without_a_key_is_legacy() {
        assert_eq!(OwnerId::from_auth(None), OwnerId::legacy());
        assert_eq!(OwnerId::from_auth(Some("")), OwnerId::legacy());
        assert_eq!(OwnerId::legacy().as_str(), "legacy");
    }

    #[test]
    fn two_keys_are_two_owners_and_one_key_is_one() {
        let a = OwnerId::from_auth(Some("hub-a-key"));
        assert_eq!(a, OwnerId::from_auth(Some("hub-a-key")));
        assert_ne!(a, OwnerId::from_auth(Some("hub-b-key")));
        assert_ne!(a, OwnerId::legacy());
    }

    #[test]
    fn logs_see_eight_characters_of_an_owner_at_most() {
        let owner = OwnerId::from_hub_key("abc");
        assert_eq!(owner.short(), "ba7816bf");
        assert_eq!(format!("{owner:?}"), "OwnerId(ba7816bf)");
        assert_eq!(OwnerId::legacy().short(), "legacy");
    }

    #[test]
    fn test_ct_eq_match() {
        assert!(ct_eq(b"deadbeef", b"deadbeef"));
    }

    #[test]
    fn test_ct_eq_mismatch() {
        assert!(!ct_eq(b"deadbeef", b"deadbee0"));
    }

    #[test]
    fn test_ct_eq_length_mismatch() {
        assert!(!ct_eq(b"short", b"longer"));
    }
}
