//! The log sinks of a host without `tauri-plugin-log`: stderr and a
//! size-rotated `reflect.log`. With no `tracing` subscriber installed, the
//! `tracing` crate's `log` feature turns every event into a `log` record.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use log::{Level, LevelFilter, Log, Metadata, Record};

/// The active log file.
const FILE_NAME: &str = "reflect.log";

/// `reflect.log` rotates once it reaches this size.
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// Rotated files to keep next to the active one.
const MAX_ROTATED_FILES: usize = 3;

/// Installs the logger: stderr plus `<log_dir>/reflect.log`, or stderr alone
/// with no directory or when the file cannot be opened. Only the first call
/// in a process installs it.
pub fn init(log_dir: Option<&Path>) {
    let level = level_from_env(std::env::var("RUST_LOG").ok().as_deref());
    let file = log_dir.and_then(|dir| LogFile::open(dir, MAX_FILE_SIZE).ok());
    let has_file = file.is_some();
    let logger = Logger {
        level,
        file: Mutex::new(file),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(level);
        if !has_file && log_dir.is_some() {
            tracing::warn!("log file unavailable; logging to stderr only");
        }
        tracing::info!("logging started");
    }
}

/// Writes one line of the host or the web app under the target `host`.
pub fn write(level: Level, message: &str) {
    log::log!(target: "host", level, "{message}");
}

/// `RUST_LOG` as one global level (`debug`, `warn`, ...), `info` otherwise.
fn level_from_env(value: Option<&str>) -> LevelFilter {
    value
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(LevelFilter::Info)
}

struct Logger {
    level: LevelFilter,
    file: Mutex<Option<LogFile>>,
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = jiff::Timestamp::now();
        let line = format!(
            "{}[{}][{}] {}\n",
            now.strftime("[%Y-%m-%d][%H:%M:%S]"),
            record.target(),
            record.level(),
            record.args()
        );
        eprint!("{line}");
        let mut file = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(file) = file.as_mut() {
            // A failed write must not fail the caller; stderr has the line.
            let _ = file.write(&line, &now.strftime("%Y-%m-%d_%H-%M-%S").to_string());
        }
    }

    fn flush(&self) {
        let mut file = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(file) = file.as_mut() {
            let _ = file.file.flush();
        }
    }
}

/// `reflect.log` in one directory, with its size.
struct LogFile {
    dir: PathBuf,
    file: File,
    size: u64,
    max_size: u64,
}

impl LogFile {
    fn open(dir: &Path, max_size: u64) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(FILE_NAME))?;
        let size = file.metadata()?.len();
        Ok(Self {
            dir: dir.to_path_buf(),
            file,
            size,
            max_size,
        })
    }

    /// Appends `line`. A file that would pass the size limit first becomes
    /// `reflect_<stamp>.log`, and only the newest rotated files stay.
    fn write(&mut self, line: &str, stamp: &str) -> std::io::Result<()> {
        if self.size > 0 && self.size + line.len() as u64 > self.max_size {
            self.rotate(stamp)?;
        }
        self.file.write_all(line.as_bytes())?;
        self.size += line.len() as u64;
        Ok(())
    }

    fn rotate(&mut self, stamp: &str) -> std::io::Result<()> {
        self.file.flush()?;
        let mut rotated = self.dir.join(format!("reflect_{stamp}.log"));
        let mut suffix = 1;
        while rotated.exists() {
            rotated = self.dir.join(format!("reflect_{stamp}_{suffix}.log"));
            suffix += 1;
        }
        std::fs::rename(self.dir.join(FILE_NAME), rotated)?;
        *self = Self::open(&self.dir, self.max_size)?;

        let mut old: Vec<PathBuf> = std::fs::read_dir(&self.dir)?
            .filter_map(|entry| Some(entry.ok()?.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("reflect_") && name.ends_with(".log"))
            })
            .collect();
        old.sort();
        let excess = old.len().saturating_sub(MAX_ROTATED_FILES);
        for path in old.into_iter().take(excess) {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_from_env_parses_one_level_or_defaults_to_info() {
        assert_eq!(level_from_env(None), LevelFilter::Info);
        assert_eq!(level_from_env(Some("debug")), LevelFilter::Debug);
        assert_eq!(level_from_env(Some("core=debug")), LevelFilter::Info);
    }

    #[test]
    fn log_file_appends_and_keeps_the_newest_rotated_files() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let mut file = LogFile::open(&logs, 10).unwrap();
        for stamp in ["a", "b", "c", "d", "e"] {
            file.write("12345678\n", stamp).unwrap();
        }
        drop(file);

        let mut names: Vec<String> = std::fs::read_dir(&logs)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "reflect.log",
                "reflect_c.log",
                "reflect_d.log",
                "reflect_e.log"
            ]
        );
        assert_eq!(
            std::fs::read_to_string(logs.join("reflect.log")).unwrap(),
            "12345678\n"
        );

        let mut reopened = LogFile::open(&logs, 100).unwrap();
        reopened.write("more\n", "f").unwrap();
        assert_eq!(
            std::fs::read_to_string(logs.join("reflect.log")).unwrap(),
            "12345678\nmore\n"
        );
    }
}
