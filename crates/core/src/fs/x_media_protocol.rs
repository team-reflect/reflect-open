//! The lookup half of the `reflect-asset://<generation>/x-media/<post>/<hash>`
//! route: which archived X media file a request names, waiting for its shared
//! download to publish a complete file. The shell owns the scheme handler,
//! the `Range` header and the file read.

use std::path::PathBuf;

use reflect_graph_io::root_for_generation;
use reflect_graph_io::x_archive_store as archive;

use crate::Core;

/// HTTP status for a malformed request path.
pub const STATUS_BAD_REQUEST: u16 = 400;
/// HTTP status for a request the graph session refuses.
pub const STATUS_FORBIDDEN: u16 = 403;
/// HTTP status for a post or resource the archive does not hold.
pub const STATUS_NOT_FOUND: u16 = 404;
/// HTTP status for a failed media download.
pub const STATUS_BAD_GATEWAY: u16 = 502;

/// One validated X media request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XMediaRequest {
    pub generation: u64,
    pub post_id: String,
    pub hash: String,
}

/// A downloaded X media file, ready to read.
#[derive(Debug, Clone)]
pub struct XMediaFile {
    /// The graph root the file lives under, as `assets/x/<receipt.name>`.
    pub root: PathBuf,
    pub receipt: archive::Receipt,
}

/// Parses `<generation>/x-media/<post>/<hash>` (already percent-decoded), or
/// returns the HTTP status to refuse it with.
pub fn parse_x_media_path(path: &str) -> Result<XMediaRequest, u16> {
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() != 4 || segments[1] != "x-media" {
        return Err(STATUS_BAD_REQUEST);
    }
    let Ok(generation) = segments[0].parse::<u64>() else {
        return Err(STATUS_BAD_REQUEST);
    };
    let post_id = segments[2].to_string();
    let hash = segments[3].to_string();
    if !archive::valid_id(&post_id) || !archive::valid_hash(&hash) {
        return Err(STATUS_BAD_REQUEST);
    }
    Ok(XMediaRequest {
        generation,
        post_id,
        hash,
    })
}

/// The answer of the `x_media_resolve` command: the file to serve, or the HTTP
/// status to refuse the request with.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum XMediaResolved {
    File {
        path: PathBuf,
        mime: String,
        bytes: u64,
    },
    Refused {
        status: u16,
    },
}

impl Core {
    /// Resolves the percent-decoded request path `<generation>/x-media/<post>/<hash>`
    /// for a shell that reads the file itself. It waits like [`Core::x_media_file`].
    pub async fn x_media_resolve(&self, path: String) -> XMediaResolved {
        let request = match parse_x_media_path(&path) {
            Ok(request) => request,
            Err(status) => return XMediaResolved::Refused { status },
        };
        let XMediaFile { root, receipt } = match self.x_media_file(request).await {
            Ok(file) => file,
            Err(status) => return XMediaResolved::Refused { status },
        };
        match reflect_graph_io::resolve(&root, &format!("assets/x/{}", receipt.name)) {
            Ok(path) => XMediaResolved::File {
                path,
                mime: receipt.mime,
                bytes: receipt.bytes,
            },
            Err(_) => XMediaResolved::Refused {
                status: STATUS_FORBIDDEN,
            },
        }
    }

    /// Finds the archived media `request` names and waits until its shared
    /// download publishes a complete file, or returns the HTTP status to
    /// refuse it with.
    pub async fn x_media_file(&self, request: XMediaRequest) -> Result<XMediaFile, u16> {
        let XMediaRequest {
            generation,
            post_id,
            hash,
        } = request;
        let Ok(root) = root_for_generation(&self.graph, generation) else {
            return Err(STATUS_FORBIDDEN);
        };
        let lookup_root = root.clone();
        let source = self
            .spawn_blocking(move || archive::resource_url(&lookup_root, &post_id, &hash))
            .await;
        let Ok(source) = source else {
            return Err(STATUS_NOT_FOUND);
        };
        // Keep this request pending until the shared download publishes a complete file.
        let Ok(receipt) = super::x_download::download(root.clone(), source).await else {
            return Err(STATUS_BAD_GATEWAY);
        };
        Ok(XMediaFile { root, receipt })
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::core;

    #[test]
    fn x_media_resolve_answers_the_refusal_status() {
        let core = core();
        let reply = |path: &str| {
            let args = serde_json::json!({ "path": path }).to_string();
            let reply = core
                .runtime
                .block_on(core.dispatch("x_media_resolve", args.as_bytes(), b"{}", None))
                .unwrap();
            match reply {
                crate::Reply::Json(json) => json,
                crate::Reply::Bytes(_) => panic!("expected JSON"),
            }
        };
        assert_eq!(reply("1/x-media/not-a-post/abc"), r#"{"status":400}"#);
        assert_eq!(
            reply(&format!("1/x-media/123/{}", "a".repeat(64))),
            r#"{"status":403}"#
        );
    }
}
