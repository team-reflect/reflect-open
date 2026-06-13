//! Shared `.gitignore` defaults for graph roots.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::AppResult;

const DEFAULT_GROUPS: &[(&str, &[&str])] = &[
    (
        "Reflect local index + caches (rebuildable; never committed)",
        &["/.reflect/"],
    ),
    ("macOS Finder metadata", &[".DS_Store", "._*"]),
    (
        "Windows Explorer metadata",
        &["Thumbs.db", "ehthumbs.db", "Desktop.ini"],
    ),
    ("Editor swap and backup files", &["*.swp", "*.swo", "*~"]),
];

/// The default `.gitignore` written for newly bootstrapped graphs.
pub(crate) fn default_contents() -> String {
    let mut contents = String::new();
    for &(heading, patterns) in DEFAULT_GROUPS {
        if !contents.is_empty() {
            contents.push('\n');
        }
        contents.push_str("# ");
        contents.push_str(heading);
        contents.push('\n');
        for pattern in patterns {
            contents.push_str(pattern);
            contents.push('\n');
        }
    }
    contents
}

/// Ensure graph repositories ignore only local machine/cache noise.
pub(crate) fn ensure_defaults(root: &Path) -> AppResult<()> {
    let path = root.join(".gitignore");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut missing_groups: Vec<(&str, Vec<&str>)> = Vec::new();

    for &(heading, patterns) in DEFAULT_GROUPS {
        let missing_patterns = patterns
            .iter()
            .copied()
            .filter(|pattern| !has_pattern(&existing, pattern))
            .collect::<Vec<_>>();
        if !missing_patterns.is_empty() {
            missing_groups.push((heading, missing_patterns));
        }
    }

    if missing_groups.is_empty() {
        return Ok(());
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    let mut prefix = if existing.is_empty() {
        ""
    } else if existing.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };

    for (heading, patterns) in missing_groups {
        writeln!(file, "{prefix}# {heading}")?;
        for pattern in patterns {
            writeln!(file, "{pattern}")?;
        }
        prefix = "\n";
    }

    Ok(())
}

fn has_pattern(existing: &str, pattern: &str) -> bool {
    existing
        .lines()
        .map(str::trim)
        .any(|line| line == pattern || is_reflect_equivalent(line, pattern))
}

fn is_reflect_equivalent(line: &str, pattern: &str) -> bool {
    pattern == "/.reflect/" && matches!(line, "/.reflect" | ".reflect/" | ".reflect")
}
