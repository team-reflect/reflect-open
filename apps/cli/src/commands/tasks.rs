//! `reflect tasks` — list the tasks of the graph from the index: the open
//! ones, the completed ones (`--done`), or both (`--all`), of every note or
//! of one note (`--note`). Like `search` it requires the index, warns when
//! the index is stale, and leaves out every private note.

use reflect_index_schema::{INDEX_FILE, REFLECT_DIR};
use reflect_types::NoteTasks;

use crate::commands::output::{TaskJson, TasksJson, print_json};
use crate::commands::warn;
use crate::error::CliError;
use crate::graph::Graph;
use crate::index::{IndexOpen, detect_staleness, open_read_only};
use crate::note_file::{ensure_not_private, read_note, subject_display_title};
use crate::resolve::resolve_note;

pub fn run(
    graph: &Graph,
    json: bool,
    checked: Option<bool>,
    note_arg: Option<&str>,
) -> Result<(), CliError> {
    let opened = match open_read_only(&graph.root) {
        IndexOpen::Opened(opened) => opened,
        IndexOpen::Missing => {
            return Err(CliError::NoIndex(format!(
                "no index at {REFLECT_DIR}/{INDEX_FILE} — open this graph in Reflect to build it"
            )));
        }
        IndexOpen::Unusable(message) => return Err(CliError::NoIndex(message)),
    };
    if opened.index_too_new {
        warn("the index schema is newer than this CLI — update Reflect");
    }

    let paths = match note_arg {
        Some(arg) => {
            let resolved = resolve_note(arg, &graph.root, Some(&opened.conn))?;
            // Refuses a private note before any of its tasks are read. A
            // daily note that does not exist yet has no tasks.
            ensure_not_private(&graph.root, resolved.rel_path())?;
            Some(vec![resolved.rel_path().to_owned()])
        }
        None => None,
    };

    let staleness = detect_staleness(&opened.conn, &graph.root)?;
    if staleness.is_stale() {
        warn(format!(
            "the index may be stale ({} file(s) differ from it) — open the graph in Reflect to refresh",
            staleness.total()
        ));
    }

    let mut notes: Vec<NoteTasks> =
        reflect_index::read::tasks::tasks(&opened.conn, checked, paths.as_deref(), true)
            .map_err(|err| CliError::runtime(err.message()))?
            .into_iter()
            // The file's own frontmatter decides; an unreadable file fails closed.
            .filter(|note| read_note(&graph.root, &note.path).is_ok())
            .collect();
    for note in &mut notes {
        note.tasks
            .sort_by(|left, right| left.ast_path.cmp(&right.ast_path));
    }

    if json {
        return print_json(&TasksJson {
            stale: staleness.is_stale(),
            tasks: notes
                .iter()
                .flat_map(|note| {
                    note.tasks.iter().map(|task| TaskJson {
                        path: &note.path,
                        title: &note.title,
                        date: note.daily_date.as_deref(),
                        markdown: &task.markdown,
                        checked: task.checked,
                        due_date: task.due_date.as_deref(),
                        breadcrumbs: &task.breadcrumbs,
                    })
                })
                .collect(),
        });
    }
    for note in &notes {
        println!("{}\t{}", note.path, subject_display_title(&note.title));
        for task in &note.tasks {
            let mark = if task.checked { 'x' } else { ' ' };
            let mut labels = task.breadcrumbs.clone();
            labels.push(task.markdown.clone());
            println!("    [{mark}] {}", labels.join(" > ").replace('\n', " "));
        }
    }
    Ok(())
}
