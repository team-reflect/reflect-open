use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

#[derive(Default, Serialize, Deserialize)]
struct Bindings {
    roots: BTreeMap<String, PathBuf>,
}

pub fn handle(payload: &[u8], pointer: &Path) -> Value {
    match process(payload, pointer) {
        Ok(value) => value,
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    }
}
fn process(payload: &[u8], pointer: &Path) -> Result<Value> {
    anyhow::ensure!(
        payload.len() <= reflect_x_archive::MESSAGE_MAX_BYTES,
        "payload-too-large"
    );
    let request: Value = serde_json::from_slice(payload)?;
    anyhow::ensure!(request["version"] == 2, "invalid-version");
    let directory = pointer.parent().context("missing-config")?;
    std::fs::create_dir_all(directory)?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(directory.join("x-bindings.lock"))?;
    lock.lock_exclusive()?;
    let path = directory.join("x-bindings.json");
    let mut bindings: Bindings = match File::open(&path) {
        Ok(file) => serde_json::from_reader(file)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Bindings::default(),
        Err(error) => return Err(error.into()),
    };
    // FIXME: `work.bind`, `x-bindings.json`, its lock file and a uuid per canonicalized graph root
    // exist so a download started under one graph can finish after the pointer changes. The pointer
    // already names the current graph, and the existing capture inbox simply waits until that graph
    // is pointed again. Delete the binding layer; `capture.put` becomes the deleted
    // `bookmark::spool` (write `.reflect/inbox/<id>.json`) with the archive attached.
    let bind = request["op"] == "work.bind";
    let capture = request["op"] == "capture.put";
    if bind {
        let pointer =
            crate::spool::read_pointer(pointer).map_err(|_| anyhow::anyhow!("no-graph"))?;
        let root = PathBuf::from(pointer.graph_root).canonicalize()?;
        let existing = bindings
            .roots
            .iter()
            .find(|(_, saved)| **saved == root)
            .map(|(key, _)| key.clone());
        let binding = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        bindings.roots.insert(binding.clone(), root);
        reflect_x_archive::atomic_json(
            directory,
            "x-bindings.json",
            &serde_json::to_value(&bindings)?,
        )?;
        return Ok(json!({"ok":true,"binding":binding,"data":null}));
    }
    let binding = if capture {
        let id = request["envelope"]["id"]
            .as_str()
            .context("invalid-event")?;
        uuid::Uuid::parse_str(id)?;
        id.to_string()
    } else {
        request["binding"]
            .as_str()
            .context("missing-binding")?
            .to_string()
    };
    if capture && !bindings.roots.contains_key(&binding) {
        let pointer =
            crate::spool::read_pointer(pointer).map_err(|_| anyhow::anyhow!("no-graph"))?;
        let root = PathBuf::from(pointer.graph_root).canonicalize()?;
        bindings.roots.insert(binding.clone(), root);
        reflect_x_archive::atomic_json(
            directory,
            "x-bindings.json",
            &serde_json::to_value(&bindings)?,
        )?;
    }
    let root = bindings
        .roots
        .get(&binding)
        .context("unknown-binding")?
        .clone();
    FileExt::unlock(&lock)?;
    anyhow::ensure!(root.is_dir(), "graph-unavailable");
    let data = reflect_x_archive::dispatch(&root, &request)?;
    Ok(json!({"ok":true,"binding":binding,"data":data}))
}
