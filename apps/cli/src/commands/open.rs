//! `reflect open <note>` — resolve like `show`/`path`, then navigate the
//! Reflect app there by handing the OS URL opener a `reflect://` deep link
//! (docs/deep-links.md). The URL prefers the most durable address the note
//! has: the date form for dailies, the frontmatter `id` form when the note
//! carries one (it survives renames), else the graph-relative path form.
//! `--print` emits the URL on stdout without launching anything — the
//! scriptable half, and how the integration tests exercise this command.

use std::fs;
use std::path::Path;
use std::process::Command;

use crate::commands::open_index_for_resolution;
use crate::commands::output::{print_json, OpenJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::{ensure_not_private, parse_note_meta};
use crate::paths::{date_from_daily_path, parse_calendar_date};
use crate::resolve::{resolve_note, ResolvedNote};

pub fn run(graph: &Graph, json: bool, note_arg: &str, print: bool) -> Result<(), CliError> {
    let index = open_index_for_resolution(&graph.root);
    let resolved = resolve_note(note_arg, &graph.root, index.as_ref().map(|open| &open.conn))?;

    // The privacy contract holds on this surface like every other: a private
    // note is refused (exit 3, same as not-found) before its address leaks.
    // A daily that doesn't exist yet is fine — navigation creates it lazily.
    let rel_path = resolved.rel_path();
    ensure_not_private(&graph.root, rel_path)?;

    let url = deep_link_url(&graph.root, &resolved);
    let launched = !print;
    if json {
        let date = match &resolved {
            ResolvedNote::Daily { date, .. } => Some(date.as_str()),
            ResolvedNote::File { rel_path } => date_from_daily_path(rel_path),
        };
        print_json(&OpenJson {
            date,
            path: rel_path,
            url: &url,
            launched,
        })?;
    } else {
        println!("{url}");
    }
    if launched {
        launch(&url)?;
    }
    Ok(())
}

/// The most durable `reflect://` address for a resolved note. Mirrors the
/// desktop's "Copy deep link" preference order, minus the minting — the CLI
/// never writes, so a note without an id gets the path form instead.
fn deep_link_url(root: &Path, resolved: &ResolvedNote) -> String {
    if let Some(date) = date_from_daily_path(resolved.rel_path()).and_then(parse_calendar_date) {
        // Calendar-validated: a daily/ file with an impossible date opens as
        // a plain note in the app, so it gets a note-form address below.
        return format!("reflect://daily/{date}");
    }
    match resolved {
        ResolvedNote::Daily { date, .. } => format!("reflect://daily/{date}"),
        ResolvedNote::File { rel_path } => {
            let id = fs::read_to_string(root.join(rel_path))
                .ok()
                .and_then(|content| parse_note_meta(rel_path, &content).id)
                .filter(|id| !id.trim().is_empty());
            let target = id.as_deref().unwrap_or(rel_path);
            format!("reflect://note/{}", encode_uri_component(target))
        }
    }
}

/// JS `encodeURIComponent`, byte for byte — the desktop's deep-link parser
/// decodes with `decodeURIComponent`, so the two must agree on the alphabet.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Hand the URL to the platform opener. Blocking on the opener's exit keeps
/// failures loud (exit 1) — the opener itself returns as soon as the URL is
/// dispatched, it does not wait on the app.
fn launch(url: &str) -> Result<(), CliError> {
    let status = launcher(url)
        .status()
        .map_err(|err| CliError::Runtime(format!("could not run the OS URL opener: {err}")))?;
    if !status.success() {
        return Err(CliError::Runtime(format!(
            "the OS URL opener failed for {url}"
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launcher(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "linux")]
fn launcher(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}

#[cfg(windows)]
fn launcher(url: &str) -> Command {
    let mut command = Command::new("cmd");
    // The empty string is `start`'s window-title slot; without it the URL
    // itself would be consumed as the title.
    command.args(["/C", "start", "", url]);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_matches_encode_uri_component() {
        assert_eq!(encode_uri_component("notes/foo.md"), "notes%2Ffoo.md");
        assert_eq!(encode_uri_component("Project X"), "Project%20X");
        assert_eq!(
            encode_uri_component("a-b_c.d!e~f*g'h(i)j"),
            "a-b_c.d!e~f*g'h(i)j"
        );
        assert_eq!(encode_uri_component("größe"), "gr%C3%B6%C3%9Fe");
        assert_eq!(encode_uri_component("a&b=c?d#e"), "a%26b%3Dc%3Fd%23e");
    }

    #[test]
    fn daily_resolutions_get_the_date_form() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = ResolvedNote::Daily {
            date: "2026-07-01".to_string(),
            rel_path: "daily/2026-07-01.md".to_string(),
        };
        assert_eq!(
            deep_link_url(dir.path(), &resolved),
            "reflect://daily/2026-07-01"
        );
    }

    #[test]
    fn a_daily_file_resolved_by_path_still_gets_the_date_form() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = ResolvedNote::File {
            rel_path: "daily/2026-07-01.md".to_string(),
        };
        assert_eq!(
            deep_link_url(dir.path(), &resolved),
            "reflect://daily/2026-07-01"
        );
    }

    #[test]
    fn an_impossible_date_daily_file_gets_the_path_form() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = ResolvedNote::File {
            rel_path: "daily/2026-02-31.md".to_string(),
        };
        assert_eq!(
            deep_link_url(dir.path(), &resolved),
            "reflect://note/daily%2F2026-02-31.md"
        );
    }

    #[test]
    fn notes_prefer_the_frontmatter_id_over_the_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(
            dir.path().join("notes/a.md"),
            "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# A\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("notes/b.md"), "# B, no id\n").unwrap();

        let with_id = ResolvedNote::File {
            rel_path: "notes/a.md".to_string(),
        };
        assert_eq!(
            deep_link_url(dir.path(), &with_id),
            "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw"
        );

        let without_id = ResolvedNote::File {
            rel_path: "notes/b.md".to_string(),
        };
        assert_eq!(
            deep_link_url(dir.path(), &without_id),
            "reflect://note/notes%2Fb.md"
        );
    }
}
