//! Mints the ephemeral TLS identities consumed by the hub test suite.
//!
//! This executable is intentionally separate from the N-API library target:
//! production Node code can load only the library, while Vitest invokes this
//! binary before its hub project starts.

use rcgen::{
    BasicConstraints, Certificate, CertificateParams, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use std::env;
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use time::{Duration, OffsetDateTime};

const MANIFEST_NAME: &str = "manifest.json";

struct Identity {
    certificate_pem: String,
    key_pem: String,
    spki: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("lasterm-tls-test-material: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let output_dir = output_dir()?;
    ensure_empty_directory(&output_dir)?;

    let now = OffsetDateTime::now_utc();
    let authority_key = KeyPair::generate()?;
    let authority = authority_certificate(now, &authority_key)?;
    let pinned = signed_leaf(now, &authority, &authority_key)?;
    let other = signed_leaf(now, &authority, &authority_key)?;
    let expired = self_signed_leaf(now - Duration::days(2), now - Duration::days(1))?;
    let server = self_signed_leaf(now, now + Duration::days(1))?;

    write_public(&output_dir.join("test-ca.pem"), &authority.pem())?;
    write_identity(&output_dir, "pinned", &pinned)?;
    write_identity(&output_dir, "other", &other)?;
    write_identity(&output_dir, "expired", &expired)?;
    write_identity(&output_dir, "server", &server)?;
    write_manifest(
        &output_dir,
        &base64(&authority_key.public_key_der()),
        &pinned,
        &other,
        &expired,
        &server,
    )?;
    Ok(())
}

fn output_dir() -> Result<PathBuf, Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--output" => Ok(PathBuf::from(path)),
        _ => Err("usage: lasterm-tls-test-material --output <empty-directory>".into()),
    }
}

fn ensure_empty_directory(path: &Path) -> io::Result<()> {
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("output directory {} does not exist", path.display()),
        ));
    }
    if fs::read_dir(path)?.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("output directory {} is not empty", path.display()),
        ));
    }
    Ok(())
}

fn authority_certificate(now: OffsetDateTime, key: &KeyPair) -> Result<Certificate, rcgen::Error> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.not_before = now - Duration::days(1);
    params.not_after = now + Duration::days(1);
    params.self_signed(key)
}

fn signed_leaf(
    now: OffsetDateTime,
    authority: &Certificate,
    authority_key: &KeyPair,
) -> Result<Identity, rcgen::Error> {
    let key = KeyPair::generate()?;
    let params = server_leaf_params(now, now + Duration::days(1))?;
    let certificate = params.signed_by(&key, authority, authority_key)?;
    Ok(identity(certificate, key))
}

fn self_signed_leaf(
    not_before: OffsetDateTime,
    not_after: OffsetDateTime,
) -> Result<Identity, rcgen::Error> {
    let key = KeyPair::generate()?;
    let params = server_leaf_params(not_before, not_after)?;
    let certificate = params.self_signed(&key)?;
    Ok(identity(certificate, key))
}

fn server_leaf_params(
    not_before: OffsetDateTime,
    not_after: OffsetDateTime,
) -> Result<CertificateParams, rcgen::Error> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.subject_alt_names = vec![SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST))];
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = not_before;
    params.not_after = not_after;
    Ok(params)
}

fn identity(certificate: Certificate, key: KeyPair) -> Identity {
    let certificate_pem = certificate.pem();
    let spki = base64(&key.public_key_der());
    Identity {
        certificate_pem,
        key_pem: key.serialize_pem(),
        spki,
    }
}

fn write_identity(output_dir: &Path, name: &str, identity: &Identity) -> io::Result<()> {
    write_public(
        &output_dir.join(format!("{name}.pem")),
        &identity.certificate_pem,
    )?;
    write_private(
        &output_dir.join(format!("{name}-key.pem")),
        &identity.key_pem,
    )
}

fn write_public(path: &Path, contents: &str) -> io::Result<()> {
    fs::write(path, contents)
}

fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    let mut file = File::options().write(true).create_new(true).open(path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn write_manifest(
    output_dir: &Path,
    authority_spki: &str,
    pinned: &Identity,
    other: &Identity,
    expired: &Identity,
    server: &Identity,
) -> io::Result<()> {
    let manifest = format!(
        concat!(
            "{{\n",
            "  \"version\": 1,\n",
            "  \"artifacts\": {{\n",
            "    \"authority\": {{ \"certificate\": \"test-ca.pem\", \"spki\": \"{}\" }},\n",
            "    \"pinned\": {{ \"certificate\": \"pinned.pem\", \"key\": \"pinned-key.pem\", \"spki\": \"{}\" }},\n",
            "    \"other\": {{ \"certificate\": \"other.pem\", \"key\": \"other-key.pem\", \"spki\": \"{}\" }},\n",
            "    \"expired\": {{ \"certificate\": \"expired.pem\", \"key\": \"expired-key.pem\", \"spki\": \"{}\" }},\n",
            "    \"server\": {{ \"certificate\": \"server.pem\", \"key\": \"server-key.pem\", \"spki\": \"{}\" }}\n",
            "  }}\n",
            "}}\n"
        ),
        authority_spki,
        pinned.spki,
        other.spki,
        expired.spki,
        server.spki,
    );
    fs::write(output_dir.join(MANIFEST_NAME), manifest)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(third & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    encoded
}
