//! The `reflect` binary: clap surface + exit-code mapping. All behavior lives
//! in the library modules so integration tests exercise the same code paths.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use reflect_cli::error::CliError;
use reflect_cli::{commands, graph};

/// Read and discover notes in a Reflect graph.
///
/// The graph resolves from --graph, then $REFLECT_GRAPH, then the nearest
/// ancestor of the current directory containing .reflect/. Notes marked
/// `private: true` are never returned. Exit codes: 0 ok, 1 error, 2 usage,
/// 3 not found or private, 4 search index missing.
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
}

fn run(cli: &Cli) -> Result<(), CliError> {
    let graph = graph::resolve(cli.graph.as_deref())?;
    match &cli.command {
        Command::Today { path } => commands::today::run(&graph, cli.json, *path),
        Command::Search { query, limit } => commands::search::run(&graph, cli.json, query, *limit),
        Command::Show { note } => commands::show::run(&graph, cli.json, note),
        Command::Path { note } => commands::path::run(&graph, cli.json, note),
        Command::Open { note, print } => commands::open::run(&graph, cli.json, note, *print),
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
