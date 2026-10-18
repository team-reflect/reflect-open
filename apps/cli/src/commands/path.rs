//! `reflect path <note>` — resolve a note to its absolute path, for piping
//! into editors and tools. A `YYYY-MM-DD` argument prints the would-be daily
//! path even before the file exists (dailies are created lazily).

use crate::commands::open_index_for_resolution;
use crate::commands::output::{print_json, PathJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::ensure_not_private;
use crate::paths::date_from_daily_path;
use crate::resolve::{resolve_note, ResolvedNote};

pub fn run(graph: &Graph, json: bool, note_arg: &str) -> Result<(), CliError> {
    let index = open_index_for_resolution(&graph.root);
    let resolved = resolve_note(note_arg, &graph.root, index.as_ref().map(|open| &open.conn))?;

    let rel_path = resolved.rel_path();
    ensure_not_private(&graph.root, rel_path)?;
    let absolute = graph.root.join(rel_path);

    if json {
        let date = match &resolved {
            ResolvedNote::Daily { date, .. } => Some(date.as_str()),
            ResolvedNote::File { rel_path } => date_from_daily_path(rel_path),
        };
        return print_json(&PathJson {
            date,
            path: rel_path,
            absolute_path: absolute.display().to_string(),
            exists: absolute.is_file(),
        });
    }
    println!("{}", absolute.display());
    Ok(())
}
