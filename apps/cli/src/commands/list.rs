//! `reflect list` — current public notes from disk, newest first.

use clap::ValueEnum;

use crate::commands::output::{print_json, ListJson, NoteSummaryJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::hash::hash_content;
use crate::note_file::{parse_note_meta, walk_notes};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Kind {
    All,
    Note,
    Daily,
    Template,
}

fn note_kind(path: &str) -> &'static str {
    if path.starts_with("daily/") {
        "daily"
    } else if path.starts_with("templates/") {
        "template"
    } else {
        "note"
    }
}

pub fn run(graph: &Graph, json: bool, kind: Kind, limit: usize) -> Result<(), CliError> {
    let mut disk_notes = walk_notes(&graph.root)?;
    disk_notes.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.rel_path.cmp(&right.rel_path))
    });
    let mut results = Vec::new();
    for disk_note in disk_notes {
        if results.len() >= limit {
            break;
        }
        let found_kind = note_kind(&disk_note.rel_path);
        let matches = match kind {
            Kind::All => true,
            Kind::Note => found_kind == "note",
            Kind::Daily => found_kind == "daily",
            Kind::Template => found_kind == "template",
        };
        if !matches {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(graph.root.join(&disk_note.rel_path)) else {
            continue;
        };
        let meta = parse_note_meta(&disk_note.rel_path, &source);
        if meta.private {
            continue;
        }
        results.push(NoteSummaryJson {
            absolute_path: graph.root.join(&disk_note.rel_path).display().to_string(),
            path: disk_note.rel_path,
            title: meta.title,
            kind: found_kind.to_string(),
            mtime: disk_note.mtime_ms,
            hash: hash_content(&source),
        });
    }
    if json {
        return print_json(&ListJson { results });
    }
    for note in results {
        println!("{}\t{}", note.path, note.title);
    }
    Ok(())
}
