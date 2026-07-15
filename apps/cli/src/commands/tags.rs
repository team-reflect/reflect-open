//! `reflect tags` — public-note tag facets from the read-only index.

use std::collections::{BTreeMap, HashSet};

use crate::commands::open_index_required;
use crate::commands::output::{print_json, TagJson, TagsJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::read_note;

pub fn run(graph: &Graph, json: bool) -> Result<(), CliError> {
    let index = open_index_required(&graph.root)?;
    let mut statement = index.conn.prepare(
        "SELECT tags.note_path, tags.tag, tags.tag_key
         FROM tags JOIN notes ON notes.path = tags.note_path
         WHERE notes.kind != 'template' AND notes.is_private = 0
         ORDER BY tags.tag_key, tags.note_path",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut public = HashSet::new();
    let mut blocked = HashSet::new();
    let mut facets: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for row in rows {
        let (note_path, tag, tag_key) = row?;
        if blocked.contains(&note_path) {
            continue;
        }
        if !public.contains(&note_path) {
            if read_note(&graph.root, &note_path).is_err() {
                blocked.insert(note_path);
                continue;
            }
            public.insert(note_path.clone());
        }
        let entry = facets.entry(tag_key).or_insert((tag, 0));
        entry.1 += 1;
    }
    let results = facets
        .into_values()
        .map(|(tag, count)| TagJson { tag, count })
        .collect::<Vec<_>>();
    if json {
        return print_json(&TagsJson { results });
    }
    for tag in results {
        println!("{}\t{}", tag.tag, tag.count);
    }
    Ok(())
}
