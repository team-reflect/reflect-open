//! Bounded native HTTP transport shared by capture and editor link previews.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{redirect, Client, StatusCode, Url};

use crate::error::{AppError, AppResult};

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;
const MAX_CONCURRENT_DNS_LOOKUPS: usize = 8;
const HTML_MAX_BYTES: usize = 2 * 1024 * 1024;
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ",
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
);

#[derive(Clone, Copy)]
enum NetworkScope {
    AnyHttp,
    PublicHttp,
}

pub(crate) struct FetchResponse {
    pub(crate) body: Vec<u8>,
    pub(crate) final_url: String,
}

type ContentTypeValidator = fn(&str, &str) -> AppResult<()>;

#[derive(Clone, Copy)]
struct RequestProfile {
    accept: &'static str,
    destination: Option<&'static str>,
    mode: Option<&'static str>,
    site: Option<&'static str>,
    upgrade_insecure_requests: bool,
}

const DOCUMENT_PROFILE: RequestProfile = RequestProfile {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    destination: Some("document"),
    mode: Some("navigate"),
    site: Some("none"),
    upgrade_insecure_requests: true,
};

const IMAGE_PROFILE: RequestProfile = RequestProfile {
    accept: "image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=0.1",
    destination: Some("image"),
    mode: Some("no-cors"),
    site: None,
    upgrade_insecure_requests: false,
};

const JSON_PROFILE: RequestProfile = RequestProfile {
    accept: "application/json",
    destination: None,
    mode: None,
    site: None,
    upgrade_insecure_requests: false,
};

#[derive(Clone, Copy)]
enum LimitBehavior {
    Truncate,
    Reject,
}

pub(crate) fn classify_fetch_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() || error.is_connect() || error.is_request() {
        AppError::Network {
            message: error.to_string(),
        }
    } else {
        AppError::io(error.to_string())
    }
}

pub(crate) fn classify_fetch_status(url: &str, status: StatusCode) -> Option<AppError> {
    if status.is_success() {
        return None;
    }
    let message = format!("{url} answered {status}");
    if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
        return Some(AppError::Network { message });
    }
    Some(AppError::io(message))
}

fn parse_http_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value)
        .map_err(|error| AppError::parse(format!("invalid URL {value}: {error}")))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(AppError::parse(format!("not an http(s) URL: {value}")));
    }
    if url.host_str().is_none() {
        return Err(AppError::parse(format!("URL has no host: {value}")));
    }
    Ok(url)
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _fourth] = address.octets();
    !(first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(embedded) = address.to_ipv4() {
        return is_public_ipv4(embedded);
    }
    let segments = address.segments();
    if segments[0] == 0x2002 {
        return is_public_ipv4(Ipv4Addr::new(
            (segments[1] >> 8) as u8,
            segments[1] as u8,
            (segments[2] >> 8) as u8,
            segments[2] as u8,
        ));
    }
    if segments[..3] == [0x0064, 0xff9b, 0x0001] {
        return false;
    }
    if segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        return is_public_ipv4(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ));
    }
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn validate_public_addresses(destination: &str, addresses: &[SocketAddr]) -> AppResult<()> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(AppError::parse(format!(
            "link preview destination is not on the public internet: {destination}"
        )));
    }
    Ok(())
}

fn validate_public_literal(url: &Url) -> AppResult<()> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::parse(format!("URL has no host: {url}")))?;
    let Ok(address) = host.trim_matches(['[', ']']).parse::<IpAddr>() else {
        return Ok(());
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AppError::parse(format!("URL has no port: {url}")))?;
    validate_public_addresses(url.as_str(), &[SocketAddr::new(address, port)])
}

fn remaining_timeout(deadline: Instant) -> AppResult<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| AppError::Network {
            message: "link preview request timed out".to_owned(),
        })
}

struct PublicDnsResolver;

static ACTIVE_DNS_LOOKUPS: AtomicUsize = AtomicUsize::new(0);

struct DnsLookupPermit;

impl DnsLookupPermit {
    fn acquire() -> io::Result<Self> {
        ACTIVE_DNS_LOOKUPS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_DNS_LOOKUPS).then_some(active + 1)
            })
            .map(|_| Self)
            .map_err(|_| io::Error::other("too many concurrent link-preview DNS lookups"))
    }
}

impl Drop for DnsLookupPermit {
    fn drop(&mut self) {
        ACTIVE_DNS_LOOKUPS.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let permit = DnsLookupPermit::acquire()
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
            let resolve_host = host.clone();
            let addresses = tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                (resolve_host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|addresses| addresses.collect::<Vec<_>>())
            })
            .await
            .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?
            .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
            validate_public_addresses(&host, &addresses).map_err(|_| {
                Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("link preview destination is not on the public internet: {host}"),
                )) as Box<dyn std::error::Error + Send + Sync>
            })?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn client_for(scope: NetworkScope) -> AppResult<&'static Client> {
    static CAPTURE_CLIENT: OnceLock<Client> = OnceLock::new();
    static PUBLIC_CLIENT: OnceLock<Client> = OnceLock::new();

    let slot = match scope {
        NetworkScope::AnyHttp => &CAPTURE_CLIENT,
        NetworkScope::PublicHttp => &PUBLIC_CLIENT,
    };
    if let Some(client) = slot.get() {
        return Ok(client);
    }

    let mut builder = Client::builder()
        .redirect(redirect::Policy::none())
        .user_agent(USER_AGENT);
    if matches!(scope, NetworkScope::PublicHttp) {
        // A system proxy would resolve and fetch the original URL itself,
        // bypassing the public-address resolver and its SSRF validation.
        builder = builder.no_proxy().dns_resolver(Arc::new(PublicDnsResolver));
    }
    let client = builder
        .build()
        .map_err(|error| AppError::io(error.to_string()))?;
    Ok(slot.get_or_init(|| client))
}

fn redirect_url(url: &Url, location: &str, scope: NetworkScope) -> AppResult<Url> {
    let redirected = url
        .join(location)
        .map_err(|error| AppError::parse(format!("invalid redirect from {url}: {error}")))?;
    let redirected = parse_http_url(redirected.as_str())?;
    if matches!(scope, NetworkScope::PublicHttp)
        && url.scheme() == "https"
        && redirected.scheme() == "http"
    {
        return Err(AppError::parse(format!(
            "link preview redirect downgrades HTTPS to HTTP: {url} -> {redirected}"
        )));
    }
    Ok(redirected)
}

async fn fetch(
    value: &str,
    scope: NetworkScope,
    profile: RequestProfile,
    max_bytes: usize,
    max_redirects: usize,
    limit_behavior: LimitBehavior,
    validate_content_type: ContentTypeValidator,
) -> AppResult<FetchResponse> {
    let deadline = Instant::now() + FETCH_TIMEOUT;
    let mut url = parse_http_url(value)?;
    let client = client_for(scope)?;
    for redirect_count in 0..=max_redirects {
        if matches!(scope, NetworkScope::PublicHttp) {
            validate_public_literal(&url)?;
        }
        let mut request = client
            .get(url.clone())
            .header("Accept", profile.accept)
            .header("Accept-Language", "en-US,en;q=0.9");
        if let Some(destination) = profile.destination {
            request = request.header("Sec-Fetch-Dest", destination);
        }
        if let Some(mode) = profile.mode {
            request = request.header("Sec-Fetch-Mode", mode);
        }
        if let Some(site) = profile.site {
            request = request.header("Sec-Fetch-Site", site);
        }
        if profile.upgrade_insecure_requests {
            request = request.header("Upgrade-Insecure-Requests", "1");
        }
        let response = request
            .timeout(remaining_timeout(deadline)?)
            .send()
            .await
            .map_err(classify_fetch_error)?;

        if response.status().is_redirection() {
            if redirect_count == max_redirects {
                return Err(AppError::io(format!("too many redirects from {value}")));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::parse(format!("redirect from {url} has no Location")))?;
            url = redirect_url(&url, location, scope)?;
            continue;
        }

        if let Some(error) = classify_fetch_status(url.as_str(), response.status()) {
            return Err(error);
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let final_url = url.to_string();
        validate_content_type(&final_url, &content_type)?;
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(classify_fetch_error)? {
            if body.len() + chunk.len() > max_bytes {
                match limit_behavior {
                    LimitBehavior::Reject => {
                        return Err(AppError::parse(format!(
                            "{final_url} answered more than {max_bytes} bytes"
                        )));
                    }
                    LimitBehavior::Truncate => {
                        let remaining = max_bytes - body.len();
                        body.extend_from_slice(&chunk[..remaining]);
                        break;
                    }
                }
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(FetchResponse { body, final_url });
    }
    unreachable!("redirect loop always returns")
}

fn validate_html_content_type(url: &str, content_type: &str) -> AppResult<()> {
    if !content_type.contains("html") {
        return Err(AppError::parse(format!(
            "{url} is not an HTML page ({content_type})"
        )));
    }
    Ok(())
}

fn validate_json_content_type(url: &str, content_type: &str) -> AppResult<()> {
    if !content_type.contains("json") {
        return Err(AppError::parse(format!(
            "{url} did not answer JSON ({content_type})"
        )));
    }
    Ok(())
}

async fn fetch_html(value: &str, scope: NetworkScope) -> AppResult<FetchResponse> {
    fetch(
        value,
        scope,
        DOCUMENT_PROFILE,
        HTML_MAX_BYTES,
        MAX_REDIRECTS,
        LimitBehavior::Truncate,
        validate_html_content_type,
    )
    .await
}

async fn fetch_bytes(
    value: &str,
    scope: NetworkScope,
    profile: RequestProfile,
    max_bytes: usize,
    validate_content_type: ContentTypeValidator,
) -> AppResult<FetchResponse> {
    fetch(
        value,
        scope,
        profile,
        max_bytes,
        MAX_REDIRECTS,
        LimitBehavior::Reject,
        validate_content_type,
    )
    .await
}

/// Fetch capture HTML while preserving capture's existing intranet behavior.
pub(crate) async fn fetch_capture_html(value: &str) -> AppResult<FetchResponse> {
    fetch_html(value, NetworkScope::AnyHttp).await
}

/// Fetch a bounded HTTPS JSON response without following redirects.
pub(crate) async fn fetch_capture_json(value: &str, max_bytes: usize) -> AppResult<FetchResponse> {
    let url = parse_http_url(value)?;
    if url.scheme() != "https" {
        return Err(AppError::parse(format!("not an https URL: {value}")));
    }
    fetch(
        value,
        NetworkScope::AnyHttp,
        JSON_PROFILE,
        max_bytes,
        0,
        LimitBehavior::Reject,
        validate_json_content_type,
    )
    .await
}

/// Fetch editor-preview HTML from public internet destinations only.
pub(crate) async fn fetch_public_html(value: &str) -> AppResult<FetchResponse> {
    fetch_html(value, NetworkScope::PublicHttp).await
}

/// Fetch a bounded image from public internet destinations only.
pub(crate) async fn fetch_public_image(
    value: &str,
    max_bytes: usize,
    validate_content_type: ContentTypeValidator,
) -> AppResult<FetchResponse> {
    fetch_bytes(
        value,
        NetworkScope::PublicHttp,
        IMAGE_PROFILE,
        max_bytes,
        validate_content_type,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_public_ip_ranges() {
        for value in [
            "http://127.0.0.1/",
            "http://10.1.2.3/",
            "http://169.254.1.1/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::7f00:1]/",
            "http://[2002:7f00:1::]/",
            "http://[64:ff9b::7f00:1]/",
            "http://[64:ff9b:1::7f00:1]/",
        ] {
            let url = parse_http_url(value).unwrap();
            assert!(validate_public_literal(&url).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_expired_fetch_deadline() {
        let deadline = Instant::now() - Duration::from_millis(1);
        assert!(matches!(
            remaining_timeout(deadline),
            Err(AppError::Network { .. })
        ));
    }

    #[test]
    fn clients_are_reused_within_each_network_scope() {
        let first = client_for(NetworkScope::PublicHttp).unwrap();
        let second = client_for(NetworkScope::PublicHttp).unwrap();
        assert!(std::ptr::eq(first, second));
    }

    #[test]
    fn accepts_public_ipv6_literals_without_dns() {
        let url = parse_http_url("https://[2606:4700:4700::1111]/").unwrap();
        assert!(validate_public_literal(&url).is_ok());
    }

    #[test]
    fn public_redirects_cannot_downgrade_https() {
        let https = parse_http_url("https://example.com/page").unwrap();
        assert!(
            redirect_url(&https, "http://example.com/other", NetworkScope::PublicHttp).is_err()
        );
        assert!(redirect_url(&https, "/other", NetworkScope::PublicHttp).is_ok());
        assert!(redirect_url(&https, "http://example.com/other", NetworkScope::AnyHttp).is_ok());
    }

    #[test]
    fn accepts_public_ip_addresses() {
        for value in [
            "https://1.1.1.1/",
            "https://[2606:4700:4700::1111]/",
            "https://[::808:808]/",
            "https://[2002:808:808::]/",
            "https://[64:ff9b::808:808]/",
        ] {
            let url = parse_http_url(value).unwrap();
            assert!(validate_public_literal(&url).is_ok(), "{value}");
        }
    }

    #[test]
    fn rejects_a_destination_with_any_non_public_answer() {
        let url = parse_http_url("https://example.com/").unwrap();
        let addresses = [
            "1.1.1.1:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap(),
        ];
        assert!(validate_public_addresses(url.as_str(), &addresses).is_err());
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(parse_http_url("file:///etc/passwd").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
    }
}
