//! Agent-skill install (Settings → Agents): writes a per-graph `SKILL.md`
//! under `~/.agents/skills/` so coding agents (Claude Code and friends)
//! discover the open graph and read it through the bundled `reflect` CLI.
//!
//! The skill is named after the graph (`reflect-<slug>`), and the rendered
//! content bakes in the graph root and the CLI's on-disk path. A managed
//! marker — an HTML comment carrying the sha256 of the rendered template —
//! makes updates safe: a file without the marker (or with the right marker
//! but edited content) was not written by us and is never overwritten or
//! deleted.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::capture::atomic_write_to;
use crate::error::{AppError, AppResult};
use crate::fs::{current_root, root_for_generation, GraphState};

/// The bundled template; placeholders are `{{SKILL_NAME}}`, `{{GRAPH_NAME}}`,
/// `{{GRAPH_ROOT}}`, and `{{CLI_PATH}}`.
const SKILL_TEMPLATE: &str = include_str!("../skills/graph-skill.md");

const MANAGED_PREFIX: &str = "<!-- reflect-managed: sha256=";
const MANAGED_SUFFIX: &str = " -->";

/// The CLI sidecar, staged beside the app binary by the Tauri bundler (and
/// beside the dev binary by `tauri dev`) — same layout as the capture host.
const CLI_BINARY: &str = if cfg!(windows) {
    "reflect.exe"
} else {
    "reflect"
};

/// Where the installed skill file stands relative to what this app would
/// write today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillInstallState {
    /// No file at the target path.
    Missing,
    /// Byte-identical to what we would write.
    Current,
    /// Ours (marker present) but rendered from older inputs — a template
    /// change, an app move, or a graph rename/move. Safe to rewrite.
    Stale,
    /// A file we don't manage: no marker, or marker with edited content.
    /// Never overwritten, never deleted.
    Conflict,
}

/// Answer for the settings card: where the skill goes, what it's called, and
/// whether the file on disk is ours.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub skill_name: String,
    pub skill_path: String,
    pub cli_path: String,
    pub install_state: SkillInstallState,
}

/// Everything derived from the open graph that the three commands share.
struct SkillContext {
    skill_name: String,
    dir: PathBuf,
    target: PathBuf,
    cli_path: PathBuf,
    rendered_hash: String,
    managed_content: String,
}

/// Kebab-case ASCII slug of a graph name; `"graph"` when nothing survives.
fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(character.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    if slug.is_empty() {
        "graph".to_string()
    } else {
        slug
    }
}

fn render_skill(skill_name: &str, graph_name: &str, graph_root: &str, cli_path: &str) -> String {
    SKILL_TEMPLATE
        .replace("{{SKILL_NAME}}", skill_name)
        .replace("{{GRAPH_NAME}}", graph_name)
        .replace("{{GRAPH_ROOT}}", graph_root)
        .replace("{{CLI_PATH}}", cli_path)
}

/// Lowercase hex sha256 (same encoding as the CLI's `hash.rs`).
fn content_hash(content: &str) -> String {
    use std::fmt::Write;
    let digest = Sha256::digest(content.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Insert the managed marker after the YAML frontmatter (agent runtimes parse
/// the frontmatter block first, so the marker must not sit above it).
fn insert_marker(source: &str, hash: &str) -> String {
    let marker = format!("{MANAGED_PREFIX}{hash}{MANAGED_SUFFIX}");
    if let Some(rest) = source.strip_prefix("---\n") {
        if let Some(index) = rest.find("\n---\n") {
            let split = "---\n".len() + index + "\n---\n".len();
            let (frontmatter, body) = source.split_at(split);
            return format!("{frontmatter}{marker}\n{body}");
        }
    }
    format!("{marker}\n{source}")
}

fn managed_hash(content: &str) -> Option<&str> {
    content.lines().find_map(|line| {
        line.trim()
            .strip_prefix(MANAGED_PREFIX)?
            .strip_suffix(MANAGED_SUFFIX)
    })
}

/// `content` with the marker's whole line removed — the inverse of
/// [`insert_marker`], so a clean install restores the exact rendered text.
fn without_marker_line(content: &str) -> Option<String> {
    let start = content.find(MANAGED_PREFIX)?;
    let line_start = content[..start].rfind('\n').map_or(0, |index| index + 1);
    let line_end = content[start..]
        .find('\n')
        .map_or(content.len(), |index| start + index + 1);
    let mut rest = String::with_capacity(content.len());
    rest.push_str(&content[..line_start]);
    rest.push_str(&content[line_end..]);
    Some(rest)
}

/// The marker is self-validating: it records the sha256 of the content it was
/// inserted into, so an edit anywhere in the file breaks the match and the
/// file classifies as [`SkillInstallState::Conflict`] — even when the app's
/// current inputs have also changed. Only a clean old install may be `Stale`.
fn classify(
    installed: Option<&str>,
    rendered_hash: &str,
    managed_content: &str,
) -> SkillInstallState {
    let Some(installed) = installed else {
        return SkillInstallState::Missing;
    };
    if installed == managed_content {
        return SkillInstallState::Current;
    }
    let (Some(hash), Some(body)) = (managed_hash(installed), without_marker_line(installed)) else {
        return SkillInstallState::Conflict;
    };
    if content_hash(&body) != hash {
        // Edited since we wrote it — the recorded hash no longer matches the
        // file's own body. Never overwrite, regardless of staleness.
        return SkillInstallState::Conflict;
    }
    if hash != rendered_hash {
        return SkillInstallState::Stale;
    }
    // Self-consistent and current by hash, yet not byte-identical (e.g. a
    // moved marker line): treat any deviation we can't explain as not ours.
    SkillInstallState::Conflict
}

/// The staged CLI sidecar, next to the running executable in both dev
/// (`target/debug/`) and the bundle (`Reflect.app/Contents/MacOS/`).
fn cli_path() -> AppResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|err| AppError::io(err.to_string()))?;
    let dir = exe
        .parent()
        .ok_or_else(|| AppError::io("executable has no parent directory"))?;
    Ok(dir.join(CLI_BINARY))
}

fn context_for(root: &Path, skills_root: &Path, cli: PathBuf) -> SkillContext {
    let graph_name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let skill_name = format!("reflect-{}", slugify(&graph_name));
    let rendered = render_skill(
        &skill_name,
        &graph_name,
        &root.to_string_lossy(),
        &cli.to_string_lossy(),
    );
    let rendered_hash = content_hash(&rendered);
    let managed_content = insert_marker(&rendered, &rendered_hash);
    let dir = skills_root.join(&skill_name);
    let target = dir.join("SKILL.md");
    SkillContext {
        skill_name,
        dir,
        target,
        cli_path: cli,
        rendered_hash,
        managed_content,
    }
}

fn context_for_graph(root: &Path) -> AppResult<SkillContext> {
    let home = dirs::home_dir().ok_or_else(|| AppError::io("no home directory"))?;
    let skills_root = home.join(".agents").join("skills");
    Ok(context_for(root, &skills_root, cli_path()?))
}

fn status_of(context: &SkillContext) -> AppResult<SkillStatus> {
    let installed = match fs::read_to_string(&context.target) {
        Ok(content) => Some(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    Ok(SkillStatus {
        skill_name: context.skill_name.clone(),
        skill_path: context.target.to_string_lossy().into_owned(),
        cli_path: context.cli_path.to_string_lossy().into_owned(),
        install_state: classify(
            installed.as_deref(),
            &context.rendered_hash,
            &context.managed_content,
        ),
    })
}

/// Command: the skill's name, target path, and install state for the open
/// graph. Read-only.
#[tauri::command]
pub fn skill_status(state: State<GraphState>) -> AppResult<SkillStatus> {
    let root = current_root(&state)?;
    status_of(&context_for_graph(&root)?)
}

/// Command: write (or refresh) the graph's skill file. Generation-pinned so
/// an install racing a graph switch can't write the wrong graph's skill.
/// Refuses to touch a file we don't manage.
#[tauri::command]
pub fn skill_install(generation: u64, state: State<GraphState>) -> AppResult<SkillStatus> {
    let root = root_for_generation(&state, generation)?;
    let context = context_for_graph(&root)?;
    let status = status_of(&context)?;
    match status.install_state {
        SkillInstallState::Conflict => Err(AppError::io(format!(
            "{} exists but was not written by Reflect — move it aside first",
            context.target.display()
        ))),
        SkillInstallState::Current => Ok(status),
        SkillInstallState::Missing => {
            // No-clobber create: a file appearing between the classify above
            // and this write fails loudly instead of being replaced.
            atomic_create_new(&context.target, &context.managed_content)?;
            status_of(&context)
        }
        SkillInstallState::Stale => {
            atomic_write_to(&context.target, &context.managed_content)?;
            status_of(&context)
        }
    }
}

/// Atomic create that refuses to replace an existing file (the missing-state
/// counterpart of `capture::atomic_write_to`).
fn atomic_create_new(path: &Path, contents: &str) -> AppResult<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io(format!("no parent directory for {}", path.display())))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents.as_bytes())?;
    tmp.flush()?;
    tmp.persist_noclobber(path)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

/// Command: remove the graph's skill file (and its directory when that leaves
/// it empty). Only removes files carrying our managed marker.
#[tauri::command]
pub fn skill_uninstall(generation: u64, state: State<GraphState>) -> AppResult<SkillStatus> {
    let root = root_for_generation(&state, generation)?;
    let context = context_for_graph(&root)?;
    let status = status_of(&context)?;
    match status.install_state {
        SkillInstallState::Missing => Ok(status),
        SkillInstallState::Conflict => Err(AppError::io(format!(
            "{} was not written by Reflect — not removing it",
            context.target.display()
        ))),
        SkillInstallState::Current | SkillInstallState::Stale => {
            fs::remove_file(&context.target)?;
            // Only removes an empty directory — anything else the user put
            // beside the skill file survives.
            let _ = fs::remove_dir(&context.dir);
            status_of(&context)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_kebab_cases_graph_names() {
        assert_eq!(slugify("Personal"), "personal");
        assert_eq!(slugify("Alex's Notes"), "alex-s-notes");
        assert_eq!(slugify("  Work 2026  "), "work-2026");
        assert_eq!(slugify("日本語"), "graph");
        assert_eq!(slugify(""), "graph");
    }

    fn test_context(dir: &Path, graph: &Path) -> SkillContext {
        context_for(
            graph,
            dir,
            PathBuf::from("/Applications/Reflect.app/Contents/MacOS/reflect"),
        )
    }

    #[test]
    fn render_bakes_in_the_graph_and_cli() {
        let context = test_context(Path::new("/skills"), Path::new("/graphs/Personal"));
        assert_eq!(context.skill_name, "reflect-personal");
        assert_eq!(
            context.target,
            Path::new("/skills/reflect-personal/SKILL.md")
        );
        assert!(context.managed_content.contains("name: reflect-personal"));
        assert!(context.managed_content.contains("/graphs/Personal"));
        assert!(context
            .managed_content
            .contains("/Applications/Reflect.app/Contents/MacOS/reflect"));
        assert!(context
            .managed_content
            .contains("git -C \"/graphs/Personal\""));
        assert!(!context.managed_content.contains("{{"));
    }

    #[test]
    fn marker_sits_after_the_frontmatter() {
        let context = test_context(Path::new("/skills"), Path::new("/graphs/Personal"));
        let close = context
            .managed_content
            .find("\n---\n")
            .expect("frontmatter closes");
        let marker = context
            .managed_content
            .find(MANAGED_PREFIX)
            .expect("marker present");
        assert!(marker > close, "marker must not sit above the frontmatter");
        assert_eq!(
            managed_hash(&context.managed_content),
            Some(context.rendered_hash.as_str())
        );
    }

    #[test]
    fn classify_walks_the_state_machine() {
        let context = test_context(Path::new("/skills"), Path::new("/graphs/Personal"));
        let hash = &context.rendered_hash;
        let managed = &context.managed_content;

        assert_eq!(classify(None, hash, managed), SkillInstallState::Missing);
        assert_eq!(
            classify(Some(managed), hash, managed),
            SkillInstallState::Current
        );
        // No marker → not ours.
        assert_eq!(
            classify(Some("# hand-written skill"), hash, managed),
            SkillInstallState::Conflict
        );
        // Right marker, edited body → not ours either.
        let edited = format!("{managed}\nuser addition\n");
        assert_eq!(
            classify(Some(&edited), hash, managed),
            SkillInstallState::Conflict
        );
        // Rendered from other inputs (graph moved, template changed) → stale,
        // but only while the old install is untouched.
        let moved = test_context(Path::new("/skills"), Path::new("/elsewhere/Personal"));
        assert_eq!(
            classify(Some(&moved.managed_content), hash, managed),
            SkillInstallState::Stale
        );
        // A user-edited old install must stay a conflict — staleness never
        // downgrades edit protection (the marker validates its own body).
        let stale_edited = format!("{}\nuser addition\n", moved.managed_content);
        assert_eq!(
            classify(Some(&stale_edited), hash, managed),
            SkillInstallState::Conflict
        );
    }

    #[test]
    fn create_new_refuses_to_replace_an_existing_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("SKILL.md");
        atomic_create_new(&target, "first").expect("create");
        assert!(atomic_create_new(&target, "second").is_err());
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "first");
    }

    #[test]
    fn install_round_trip_on_disk() {
        let temp = tempfile::tempdir().expect("tempdir");
        let context = test_context(temp.path(), Path::new("/graphs/Personal"));

        assert_eq!(
            status_of(&context).expect("status").install_state,
            SkillInstallState::Missing
        );

        atomic_write_to(&context.target, &context.managed_content).expect("write");
        assert_eq!(
            status_of(&context).expect("status").install_state,
            SkillInstallState::Current
        );

        // A graph rename changes the slug-independent inputs → stale, and a
        // rewrite with the new context heals it.
        let renamed = context_for(
            Path::new("/graphs/Personal Renamed"),
            temp.path(),
            PathBuf::from("/Applications/Reflect.app/Contents/MacOS/reflect"),
        );
        assert_eq!(renamed.skill_name, "reflect-personal-renamed");

        // User edits below the marker turn the file into a conflict.
        let mut edited = context.managed_content.clone();
        edited.push_str("\n## My notes\n");
        std::fs::write(&context.target, &edited).expect("edit");
        assert_eq!(
            status_of(&context).expect("status").install_state,
            SkillInstallState::Conflict
        );
    }
}
