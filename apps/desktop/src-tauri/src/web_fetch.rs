//! Bounded native HTTP transport shared by capture and editor link previews.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

use reqwest::{redirect, StatusCode, Url};

use crate::error::{AppError, AppResult};

pub(crate) const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;
const HTML_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const USER_AGENT: &str = concat!(
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
    pub(crate) content_type: String,
    pub(crate) final_url: String,
}

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

fn validate_public_addresses(url: &Url, addresses: &[SocketAddr]) -> AppResult<()> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(AppError::parse(format!(
            "link preview destination is not on the public internet: {url}"
        )));
    }
    Ok(())
}

fn remaining_timeout(deadline: Instant) -> AppResult<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| AppError::Network {
            message: "link preview request timed out".to_owned(),
        })
}

async fn resolve_public(url: &Url, deadline: Instant) -> AppResult<(String, Vec<SocketAddr>)> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::parse(format!("URL has no host: {url}")))?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AppError::parse(format!("URL has no port: {url}")))?;
    let resolve_host = host.clone();
    let resolve_task = tauri::async_runtime::spawn_blocking(move || {
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    });
    let addresses = tokio::time::timeout(remaining_timeout(deadline)?, resolve_task)
        .await
        .map_err(|_| AppError::Network {
            message: format!("timed out resolving {host}"),
        })?
        .map_err(|error| AppError::io(format!("DNS task failed: {error}")))?
        .map_err(|error| AppError::Network {
            message: format!("could not resolve {host}: {error}"),
        })?;
    validate_public_addresses(url, &addresses)?;
    Ok((host, addresses))
}

async fn client_for(
    url: &Url,
    scope: NetworkScope,
    deadline: Instant,
) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(remaining_timeout(deadline)?)
        .user_agent(USER_AGENT);
    if matches!(scope, NetworkScope::PublicHttp) {
        let (host, addresses) = resolve_public(url, deadline).await?;
        // A system proxy would resolve and fetch the original URL itself,
        // bypassing both our DNS validation and address pinning.
        builder = builder.no_proxy().resolve_to_addrs(&host, &addresses);
    }
    builder
        .build()
        .map_err(|error| AppError::io(error.to_string()))
}

async fn fetch(
    value: &str,
    scope: NetworkScope,
    accept: &str,
    max_bytes: usize,
    limit_behavior: LimitBehavior,
) -> AppResult<FetchResponse> {
    let deadline = Instant::now() + FETCH_TIMEOUT;
    let mut url = parse_http_url(value)?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let client = client_for(&url, scope, deadline).await?;
        let response = client
            .get(url.clone())
            .header("Accept", accept)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "none")
            .header("Upgrade-Insecure-Requests", "1")
            .send()
            .await
            .map_err(classify_fetch_error)?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(AppError::io(format!("too many redirects from {value}")));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::parse(format!("redirect from {url} has no Location")))?;
            url = url.join(location).map_err(|error| {
                AppError::parse(format!("invalid redirect from {url}: {error}"))
            })?;
            url = parse_http_url(url.as_str())?;
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
        return Ok(FetchResponse {
            body,
            content_type,
            final_url,
        });
    }
    unreachable!("redirect loop always returns")
}

async fn fetch_html(value: &str, scope: NetworkScope) -> AppResult<FetchResponse> {
    let response = fetch(
        value,
        scope,
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        HTML_MAX_BYTES,
        LimitBehavior::Truncate,
    )
    .await?;
    if !response.content_type.contains("html") {
        return Err(AppError::parse(format!(
            "{} is not an HTML page ({})",
            response.final_url, response.content_type
        )));
    }
    Ok(response)
}

async fn fetch_bytes(
    value: &str,
    scope: NetworkScope,
    accept: &str,
    max_bytes: usize,
) -> AppResult<FetchResponse> {
    fetch(value, scope, accept, max_bytes, LimitBehavior::Reject).await
}

/// Fetch capture HTML while preserving capture's existing intranet behavior.
pub(crate) async fn fetch_capture_html(value: &str) -> AppResult<FetchResponse> {
    fetch_html(value, NetworkScope::AnyHttp).await
}

/// Fetch editor-preview HTML from public internet destinations only.
pub(crate) async fn fetch_public_html(value: &str) -> AppResult<FetchResponse> {
    fetch_html(value, NetworkScope::PublicHttp).await
}

/// Fetch bounded bytes from public internet destinations only.
pub(crate) async fn fetch_public_bytes(
    value: &str,
    accept: &str,
    max_bytes: usize,
) -> AppResult<FetchResponse> {
    fetch_bytes(value, NetworkScope::PublicHttp, accept, max_bytes).await
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
        ] {
            let url = parse_http_url(value).unwrap();
            let port = url.port_or_known_default().unwrap();
            let address = SocketAddr::new(
                url.host_str()
                    .unwrap()
                    .trim_matches(['[', ']'])
                    .parse()
                    .unwrap(),
                port,
            );
            assert!(
                validate_public_addresses(&url, &[address]).is_err(),
                "{value}"
            );
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
    fn accepts_public_ip_addresses() {
        for value in [
            "https://1.1.1.1/",
            "https://[2606:4700:4700::1111]/",
            "https://[::808:808]/",
            "https://[2002:808:808::]/",
            "https://[64:ff9b::808:808]/",
        ] {
            let url = parse_http_url(value).unwrap();
            let port = url.port_or_known_default().unwrap();
            let address = SocketAddr::new(
                url.host_str()
                    .unwrap()
                    .trim_matches(['[', ']'])
                    .parse()
                    .unwrap(),
                port,
            );
            assert!(
                validate_public_addresses(&url, &[address]).is_ok(),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_a_destination_with_any_non_public_answer() {
        let url = parse_http_url("https://example.com/").unwrap();
        let addresses = [
            "1.1.1.1:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap(),
        ];
        assert!(validate_public_addresses(&url, &addresses).is_err());
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(parse_http_url("file:///etc/passwd").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
    }
}
