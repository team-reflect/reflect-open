//! The `reflect` binary: clap surface + exit-code mapping. All behavior lives
//! in the library modules so integration tests exercise the same code paths.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use reflect_cli::error::CliError;
use reflect_cli::{commands, graph};

/// Read and manage notes in a Reflect graph.
///
/// The graph resolves from --graph, then $REFLECT_GRAPH, then the nearest
/// ancestor of the current directory containing .reflect/. Notes marked
/// `private: true` are never returned or mutated. Exit codes: 0 ok, 1 error,
/// 2 usage, 3 not found or private, 4 index missing, 5 write conflict.
#[derive(Parser)]
#[command(name = "reflect", version)]
struct Cli {
    /// Graph directory (default: nearest ancestor with .reflect/, or $REFLECT_GRAPH)
    #[arg(long, global = true, value_name = "PATH")]
    graph: Option<PathBuf>,

    /// Emit JSON on stdout instead of human-readable text
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print today's daily note
    Today {
        /// Print the daily note's absolute path instead (works before the file exists)
        #[arg(long)]
        path: bool,
    },
    /// Full-text search over the graph's search index
    Search {
        /// Search terms (matched literally, ranked by relevance)
        query: String,
        /// Maximum number of results
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// List current public notes from disk, newest first
    List {
        /// Include all notes, regular notes, dailies, or templates
        #[arg(long, value_enum, default_value = "all")]
        kind: commands::list::Kind,
        /// Maximum number of notes
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Print a note, resolved by date, path, title, or alias
    Show {
        /// A YYYY-MM-DD date, graph-relative path, note title, or alias
        note: String,
    },
    /// Resolve a note to its absolute path (for piping into editors/tools)
    Path {
        /// A YYYY-MM-DD date, graph-relative path, note title, or alias
        note: String,
    },
    /// Open a note in the Reflect app via its reflect:// deep link
    Open {
        /// A YYYY-MM-DD date, graph-relative path, note title, or alias
        note: String,
        /// Print the URL without launching the app
        #[arg(long)]
        print: bool,
    },
    /// List public notes that link to a note
    Backlinks {
        /// A date, graph-relative path, note title, or alias
        note: String,
        /// Maximum number of link rows
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// List public-note tasks from the index
    Tasks {
        /// Open, completed, or all tasks
        #[arg(long, value_enum, default_value = "open")]
        state: commands::tasks::State,
        /// Maximum number of task rows
        #[arg(long, default_value_t = 200)]
        limit: usize,
    },
    /// List public-note tag facets from the index
    Tags,
    /// Create a regular note with a title-derived path
    Create {
        /// H1 title for the new note
        title: String,
        /// Explicit graph-relative destination instead of a title slug
        #[arg(long)]
        path: Option<String>,
        /// Markdown body below the generated H1
        #[arg(long)]
        body: Option<String>,
        /// Read the Markdown body from stdin
        #[arg(long)]
        stdin: bool,
    },
    /// Append a Markdown block to a public note
    Append {
        /// A date, graph-relative path, note title, or alias
        note: String,
        /// Markdown block to append
        #[arg(long)]
        text: Option<String>,
        /// Read the Markdown block from stdin
        #[arg(long)]
        stdin: bool,
        /// Fail if the current source hash differs
        #[arg(long)]
        expect_hash: Option<String>,
    },
    /// Append a round Reflect task (today by default)
    Task {
        /// Plain task text
        text: String,
        /// Target note; defaults to today's daily note
        #[arg(long)]
        note: Option<String>,
        /// Optional ISO due date, written as a daily wiki link
        #[arg(long)]
        due: Option<String>,
        /// Fail if the current source hash differs
        #[arg(long)]
        expect_hash: Option<String>,
    },
    /// Replace a public note's full Markdown source
    Write {
        /// A date, graph-relative path, note title, or alias
        note: String,
        /// Complete Markdown source
        #[arg(long)]
        content: Option<String>,
        /// Read complete Markdown source from stdin
        #[arg(long)]
        stdin: bool,
        /// Fail if the current source hash differs
        #[arg(long)]
        expect_hash: Option<String>,
    },
    /// Move a public note to another graph-relative Markdown path
    Move {
        /// A date, graph-relative path, note title, or alias
        note: String,
        /// Destination under daily/, notes/, or templates/
        destination: String,
        /// Fail if the current source hash differs
        #[arg(long)]
        expect_hash: Option<String>,
    },
    /// Move a public note to recoverable graph-local trash
    Delete {
        /// A date, graph-relative path, note title, or alias
        note: String,
        /// Fail if the current source hash differs
        #[arg(long)]
        expect_hash: Option<String>,
    },
    /// Restore a note from a trash path returned by `delete`
    Restore {
        /// Path below `.reflect/trash/` returned by `delete`
        trash_path: String,
        /// Restore to a different graph-relative note path
        #[arg(long)]
        to: Option<String>,
    },
}

fn run(cli: &Cli) -> Result<(), CliError> {
    let graph = graph::resolve(cli.graph.as_deref())?;
    match &cli.command {
        Command::Today { path } => commands::today::run(&graph, cli.json, *path),
        Command::Search { query, limit } => commands::search::run(&graph, cli.json, query, *limit),
        Command::List { kind, limit } => commands::list::run(&graph, cli.json, *kind, *limit),
        Command::Show { note } => commands::show::run(&graph, cli.json, note),
        Command::Path { note } => commands::path::run(&graph, cli.json, note),
        Command::Open { note, print } => commands::open::run(&graph, cli.json, note, *print),
        Command::Backlinks { note, limit } => {
            commands::backlinks::run(&graph, cli.json, note, *limit)
        }
        Command::Tasks { state, limit } => commands::tasks::run(&graph, cli.json, *state, *limit),
        Command::Tags => commands::tags::run(&graph, cli.json),
        Command::Create {
            title,
            path,
            body,
            stdin,
        } => commands::create::run(
            &graph,
            cli.json,
            title,
            path.as_deref(),
            body.clone(),
            *stdin,
        ),
        Command::Append {
            note,
            text,
            stdin,
            expect_hash,
        } => commands::append::run(
            &graph,
            cli.json,
            note,
            text.clone(),
            *stdin,
            expect_hash.as_deref(),
        ),
        Command::Task {
            text,
            note,
            due,
            expect_hash,
        } => commands::task::run(
            &graph,
            cli.json,
            text,
            note.as_deref(),
            due.as_deref(),
            expect_hash.as_deref(),
        ),
        Command::Write {
            note,
            content,
            stdin,
            expect_hash,
        } => commands::write::run(
            &graph,
            cli.json,
            note,
            content.clone(),
            *stdin,
            expect_hash.as_deref(),
        ),
        Command::Move {
            note,
            destination,
            expect_hash,
        } => commands::move_note::run(&graph, cli.json, note, destination, expect_hash.as_deref()),
        Command::Delete { note, expect_hash } => {
            commands::delete::run(&graph, cli.json, note, expect_hash.as_deref())
        }
        Command::Restore { trash_path, to } => {
            commands::restore::run(&graph, cli.json, trash_path, to.as_deref())
        }
    }
}

fn main() -> ExitCode {
    match run(&Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("reflect: {err}");
            ExitCode::from(err.exit_code())
        }
    }
}
