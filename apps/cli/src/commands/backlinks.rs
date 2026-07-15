//! `reflect backlinks <note>` — incoming wiki links from the read-only index.

use rusqlite::params;

use crate::commands::open_index_for_resolution;
use crate::commands::open_index_required;
use crate::commands::output::{print_json, BacklinkJson, BacklinksJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::read_note;
use crate::resolve::resolve_note;

pub fn run(graph: &Graph, json: bool, note_arg: &str, limit: usize) -> Result<(), CliError> {
    let resolution_index = open_index_for_resolution(&graph.root);
    let resolved = resolve_note(
        note_arg,
        &graph.root,
        resolution_index.as_ref().map(|open| &open.conn),
    )?;
    let target_path = resolved.rel_path().to_string();
    if !graph.root.join(&target_path).is_file() {
        return Err(CliError::NotFound(format!(
            "note does not exist: {target_path}"
        )));
    }
    read_note(&graph.root, &target_path)?;

    let index = open_index_required(&graph.root)?;
    let mut statement = index.conn.prepare(
        "SELECT source_path, target_raw, alias, pos_from, pos_to
         FROM backlinks WHERE target_path = ?1
         ORDER BY source_path, pos_from LIMIT ?2",
    )?;
    let rows = statement.query_map(params![target_path, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut results = Vec::new();
    for row in rows {
        let (source_path, target_raw, alias, pos_from, pos_to) = row?;
        let Ok(source) = read_note(&graph.root, &source_path) else {
            continue;
        };
        results.push(BacklinkJson {
            source_path,
            source_title: source.meta.title,
            target_raw,
            alias,
            pos_from,
            pos_to,
        });
    }
    if json {
        return print_json(&BacklinksJson {
            target_path,
            results,
        });
    }
    for backlink in results {
        println!("{}\t{}", backlink.source_path, backlink.source_title);
    }
    Ok(())
}
