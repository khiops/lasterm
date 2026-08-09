//! TLS server identity verification based exclusively on a pinned SPKI.
//!
//! The verifier deliberately does not consult certificate names, validity dates,
//! or trust anchors. A hub is authenticated only when its end-entity
//! certificate contains the configured SubjectPublicKeyInfo bytes.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, Error, SignatureScheme};
use std::sync::Arc;
use webpki::EndEntityCert;

/// Verifies that the server certificate contains one exact SubjectPublicKeyInfo.
#[derive(Debug)]
pub struct SpkiPinVerifier {
    expected_spki: Vec<u8>,
    provider: Arc<CryptoProvider>,
}

impl SpkiPinVerifier {
    /// Creates a verifier for one DER-encoded SubjectPublicKeyInfo.
    pub fn new(expected_spki: Vec<u8>) -> Self {
        Self {
            expected_spki,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        }
    }
}

impl ServerCertVerifier for SpkiPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let certificate = EndEntityCert::try_from(end_entity)
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;

        if certificate.subject_public_key_info().as_ref() == self.expected_spki.as_slice() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::SpkiPinVerifier;
    use rcgen::{CertificateParams, KeyPair};
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ClientConfig, ServerConfig, ServerConnection, StreamOwned};
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::{mpsc, Arc};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    const REQUEST_BODY: &[u8] = b"request body must not reach a rejected peer";
    const BEARER_TOKEN: &str = "Bearer credential-bytes-must-not-reach-a-rejected-peer";
    const RESPONSE_BODY: &[u8] = b"pinned hub response";

    struct TestServer {
        address: SocketAddr,
        request_received: mpsc::Receiver<bool>,
        thread: JoinHandle<()>,
    }

    impl TestServer {
        fn start(certificate: CertificateDer<'static>, private_key: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback TLS server");
            let address = listener
                .local_addr()
                .expect("read loopback TLS server address");
            let (request_received_sender, request_received) = mpsc::channel();
            let thread = thread::spawn(move || {
                let server_config = ServerConfig::builder()
                    .with_no_client_auth()
                    .with_single_cert(
                        vec![certificate],
                        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(private_key)),
                    )
                    .expect("configure test TLS server");
                let (socket, _) = listener.accept().expect("accept client connection");
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("set client read timeout");
                let connection = ServerConnection::new(Arc::new(server_config))
                    .expect("create test TLS connection");
                let mut tls = StreamOwned::new(connection, socket);
                let mut request = [0_u8; 1024];
                let request_received = matches!(tls.read(&mut request), Ok(read) if read > 0);
                request_received_sender
                    .send(request_received)
                    .expect("report whether the HTTP request arrived");

                if request_received {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        RESPONSE_BODY.len()
                    );
                    tls.write_all(response.as_bytes())
                        .expect("write test HTTP response headers");
                    tls.write_all(RESPONSE_BODY)
                        .expect("write test HTTP response body");
                    tls.flush().expect("flush test HTTP response");
                }
            });

            Self {
                address,
                request_received,
                thread,
            }
        }

        fn assert_request_received(self) {
            assert!(
                self.request_received
                    .recv_timeout(Duration::from_secs(5))
                    .expect("test TLS server reports request receipt"),
                "the TLS server never received the HTTP request"
            );
            self.thread.join().expect("test TLS server exits cleanly");
        }

        fn assert_no_request_received(self) {
            assert!(
                !self
                    .request_received
                    .recv_timeout(Duration::from_secs(5))
                    .expect("test TLS server reports request receipt"),
                "the rejected peer received HTTP bytes after TLS pin validation failed"
            );
            self.thread.join().expect("test TLS server exits cleanly");
        }
    }

    fn certificate_for(key_pair: &KeyPair, expired: bool) -> CertificateDer<'static> {
        let mut params = CertificateParams::new(vec!["wrong-hostname.invalid".to_owned()])
            .expect("create test certificate parameters");
        if expired {
            params.not_before = rcgen::date_time_ymd(2000, 1, 1);
            params.not_after = rcgen::date_time_ymd(2001, 1, 1);
        }
        params
            .self_signed(key_pair)
            .expect("create self-signed test certificate")
            .der()
            .clone()
    }

    fn pinned_client(expected_spki: Vec<u8>) -> reqwest::blocking::Client {
        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SpkiPinVerifier::new(expected_spki)))
            .with_no_client_auth();

        reqwest::blocking::Client::builder()
            .no_proxy()
            .use_preconfigured_tls(config)
            .build()
            .expect("build reqwest blocking client with the pinned rustls config")
    }

    fn post_to(server: &TestServer, client: &reqwest::blocking::Client) -> reqwest::Result<String> {
        client
            .post(format!("https://{}/identity", server.address))
            .header("Authorization", BEARER_TOKEN)
            .body(REQUEST_BODY)
            .send()?
            .text()
    }

    #[test]
    fn pinned_spki_completes_reqwest_blocking_tls_request() {
        let key_pair = KeyPair::generate().expect("generate pinned key pair");
        let server = TestServer::start(certificate_for(&key_pair, false), key_pair.serialize_der());
        let response = post_to(&server, &pinned_client(key_pair.public_key_der()))
            .expect("the matching SPKI completes the blocking reqwest request");

        assert_eq!(response.as_bytes(), RESPONSE_BODY);
        server.assert_request_received();
    }

    #[test]
    fn stored_pin_rejects_different_hub_before_credential_bytes_are_sent() {
        let server_key = KeyPair::generate().expect("generate server key pair");
        let pinned_key = KeyPair::generate().expect("generate originally trusted hub key pair");
        let store_path = std::env::temp_dir().join(format!(
            "lasterm-stored-pin-test-{}",
            std::process::id()
        ));
        let store_path = store_path.join("desktop-state").join("known_hubs.json");
        let stored_pin = crate::record_or_match_hub_pin_at(
            &store_path,
            crate::LOOPBACK_HUB_PIN_KEY,
            &pinned_key.public_key_der(),
        )
        .expect("record first trusted hub key");
        let server = TestServer::start(
            certificate_for(&server_key, false),
            server_key.serialize_der(),
        );
        let error = post_to(&server, &pinned_client(stored_pin))
            .expect_err("a different SPKI must not produce an HTTP response");

        assert!(
            error.is_connect(),
            "expected a TLS connection error: {error}"
        );
        server.assert_no_request_received();
        let _ = std::fs::remove_dir_all(
            store_path
                .parent()
                .and_then(|path| path.parent())
                .expect("test store has parent"),
        );
    }

    #[test]
    fn matching_spki_ignores_expiry_and_hostname() {
        let key_pair = KeyPair::generate().expect("generate pinned key pair");
        let server = TestServer::start(certificate_for(&key_pair, true), key_pair.serialize_der());
        let response = post_to(&server, &pinned_client(key_pair.public_key_der()))
            .expect("the matching SPKI ignores the expired wrong-hostname certificate");

        assert_eq!(response.as_bytes(), RESPONSE_BODY);
        server.assert_request_received();
    }
}
