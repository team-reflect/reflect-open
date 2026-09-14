use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const VIDEO_MAX_BYTES: u64 = 10_000_000;
pub const IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MESSAGE_MAX_BYTES: usize = 512 * 1024;
pub const CHUNK_MAX_BYTES: usize = 256 * 1024;
pub const LEASE_MS: u64 = 180_000;
pub const MEDIA_EXTENSIONS: &[&str] = &["jpg", "png", "webp", "gif", "mp4"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub url: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub resource: Resource,
    pub post_ids: Vec<String>,
    pub state: String,
    pub lease: Option<String>,
    pub lease_until: u64,
    pub offset: u64,
    pub receipt: Option<Receipt>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub name: String,
    pub bytes: u64,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
pub struct State {
    pub jobs: BTreeMap<String, Job>,
    pub captures: BTreeMap<String, Value>,
    pub processed: BTreeMap<String, bool>,
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn valid_id(id: &str) -> bool {
    !id.starts_with('0')
        && !id.is_empty()
        && id.len() <= 20
        && id.bytes().all(|b| b.is_ascii_digit())
}
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn hash_url(source: &str) -> Result<String> {
    url::Url::parse(source)?;
    Ok(format!("{:x}", Sha256::digest(source.as_bytes())))
}

pub fn get_candidate_names(hash: &str) -> Result<Vec<String>> {
    ensure!(valid_hash(hash), "invalid-hash");
    Ok(MEDIA_EXTENSIONS
        .iter()
        .map(|ext| format!("url_sha256_{hash}.{ext}"))
        .collect())
}
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(root.is_absolute() && root.is_dir(), "invalid-root");
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            bail!("invalid-path")
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) => ensure!(!meta.file_type().is_symlink(), "symlink"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}
fn directory(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = safe_path(root, relative)?;
    fs::create_dir_all(&path)?;
    safe_path(root, relative)
}
pub fn atomic_json(root: &Path, relative: &str, value: &Value) -> Result<()> {
    let path = safe_path(root, relative)?;
    let parent = path.parent().context("parent")?;
    fs::create_dir_all(parent)?;
    safe_path(root, relative)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_json(root: &Path, relative: &str) -> Result<Option<Value>> {
    let path = safe_path(root, relative)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        file.metadata()?.len() <= MESSAGE_MAX_BYTES as u64,
        "payload-too-large"
    );
    Ok(Some(serde_json::from_reader(file)?))
}
fn with_state<T>(root: &Path, action: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
    directory(root, ".reflect/x-archive")?;
    let lock_path = safe_path(root, ".reflect/x-archive/lock")?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;
    lock.lock_exclusive()?;
    let state_path = safe_path(root, ".reflect/x-archive/state.json")?;
    let mut state: State = match File::open(&state_path) {
        Ok(file) => serde_json::from_reader(file)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => State::default(),
        Err(error) => return Err(error.into()),
    };
    let result = action(&mut state);
    // Error transitions, such as oversize rejection, are durable too.
    atomic_json(
        root,
        ".reflect/x-archive/state.json",
        &serde_json::to_value(&state)?,
    )?;
    FileExt::unlock(&lock)?;
    result
}
fn sniff(path: &Path) -> Result<(String, String, u64)> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let bytes = metadata.len();
    ensure!(metadata.is_file() && bytes > 0, "invalid-file");
    ensure!(bytes <= IMAGE_MAX_BYTES, "media-too-large");
    let mut prefix = vec![0; bytes.min(8192) as usize];
    file.read_exact(&mut prefix)?;
    let kind = infer::get(&prefix).context("unsupported-format")?;
    let extension = match kind.mime_type() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => {
            ensure!(bytes <= VIDEO_MAX_BYTES, "video-too-large");
            "mp4"
        }
        _ => bail!("unsupported-format"),
    };
    Ok((extension.into(), kind.mime_type().into(), bytes))
}
pub fn find_cache(root: &Path, hash: &str) -> Result<Option<Receipt>> {
    for name in get_candidate_names(hash)? {
        let path = safe_path(root, &format!("assets/x/{name}"))?;
        if !path.exists() {
            continue;
        }
        let Ok((extension, mime, bytes)) = sniff(&path) else {
            continue;
        };
        if !name.ends_with(&format!(".{extension}")) {
            continue;
        }
        // The first valid candidate wins silently.
        return Ok(Some(Receipt {
            name,
            bytes,
            mime,
            sha256: None,
        }));
    }
    Ok(None)
}
fn part_path(root: &Path, id: &str) -> Result<PathBuf> {
    let hash = id.strip_prefix("url_sha256_").context("invalid-job")?;
    ensure!(valid_hash(hash), "invalid-job");
    directory(root, ".reflect/x-archive/transfers")?;
    safe_path(root, &format!(".reflect/x-archive/transfers/{id}.part"))
}
fn add_jobs(state: &mut State, archive: &Value) -> Result<()> {
    let post_id = archive["id"].as_str().context("invalid-post")?;
    ensure!(valid_id(post_id), "invalid-post");
    for raw in archive["resources"]
        .as_array()
        .context("invalid-resources")?
    {
        let resource: Resource = serde_json::from_value(raw.clone())?;
        let hash = hash_url(&resource.url)?;
        let id = format!("url_sha256_{hash}");
        let job = state.jobs.entry(id.clone()).or_insert_with(|| Job {
            id,
            resource: resource.clone(),
            post_ids: vec![],
            state: resource.state.clone(),
            lease: None,
            lease_until: 0,
            offset: 0,
            receipt: None,
        });
        if !job.post_ids.iter().any(|id| id == post_id) {
            job.post_ids.push(post_id.into());
        }
        // Explicit recapture can reassess a formerly failed or oversized source.
        if job.state == "failed" || job.state == "unsupported" {
            job.resource = resource;
            job.state = job.resource.state.clone();
            job.lease = None;
            job.offset = 0;
        }
    }
    Ok(())
}
pub fn put_capture(root: &Path, envelope: Value) -> Result<()> {
    let id = envelope["id"]
        .as_str()
        .context("invalid-event")?
        .to_string();
    Uuid::parse_str(&id)?;
    let archive = &envelope["archive"];
    let post_id = envelope["postId"].as_str().context("invalid-post")?;
    ensure!(
        valid_id(post_id) && archive["id"] == post_id && archive["data"]["id"] == post_id,
        "wrong-post"
    );
    ensure!(
        serde_json::to_vec(&envelope)?.len() <= MESSAGE_MAX_BYTES,
        "payload-too-large"
    );
    with_state(root, |state| {
        if state.captures.contains_key(&id) {
            return Ok(());
        }
        add_jobs(state, archive)?;
        state.captures.insert(id.clone(), envelope.clone());
        Ok(())
    })?;
    // Repeated put re-creates an inbox only until a durable processed marker exists.
    with_state(root, |state| {
        if !state.processed.get(&id).copied().unwrap_or(false) {
            atomic_json(root, &format!(".reflect/inbox/{id}.json"), &envelope)?;
        }
        Ok(())
    })
}
pub fn mark_processed(root: &Path, event: &str) -> Result<()> {
    Uuid::parse_str(event)?;
    with_state(root, |state| {
        state.processed.insert(event.into(), true);
        Ok(())
    })
}
pub fn read_post(root: &Path, post_id: &str) -> Result<Option<Value>> {
    ensure!(valid_id(post_id), "invalid-post");
    let value = read_json(root, &format!("assets/x/post-{post_id}.json"))?;
    if let Some(value) = &value {
        ensure!(
            value["id"] == post_id && value["data"]["id"] == post_id,
            "wrong-post"
        );
    }
    Ok(value)
}
pub fn write_post(
    root: &Path,
    post_id: &str,
    expected: Option<&str>,
    value: &Value,
) -> Result<bool> {
    ensure!(
        valid_id(post_id) && value["id"] == post_id && value["data"]["id"] == post_id,
        "wrong-post"
    );
    ensure!(
        serde_json::to_vec(value)?.len() <= MESSAGE_MAX_BYTES,
        "payload-too-large"
    );
    with_state(root, |_| {
        let previous = read_post(root, post_id)?;
        if previous
            .as_ref()
            .and_then(|value| value["revision"].as_str())
            != expected
        {
            return Ok(false);
        }
        atomic_json(root, &format!("assets/x/post-{post_id}.json"), value)?;
        Ok(true)
    })
}
pub fn ensure_resource(root: &Path, post_id: &str, hash: &str) -> Result<Job> {
    let archive = read_post(root, post_id)?.context("not-found")?;
    let raw = archive["resources"]
        .as_array()
        .context("invalid-resources")?
        .iter()
        .find(|raw| {
            raw["url"]
                .as_str()
                .is_some_and(|url| hash_url(url).ok().as_deref() == Some(hash))
        })
        .context("resource-not-owned")?
        .clone();
    let resource: Resource = serde_json::from_value(raw)?;
    with_state(root, |state| {
        let id = format!("url_sha256_{hash}");
        let job = state.jobs.entry(id.clone()).or_insert_with(|| Job {
            id,
            resource: resource.clone(),
            post_ids: vec![post_id.into()],
            state: resource.state.clone(),
            lease: None,
            lease_until: 0,
            offset: 0,
            receipt: None,
        });
        if !job.post_ids.iter().any(|id| id == post_id) {
            job.post_ids.push(post_id.into());
        }
        if let Some(receipt) = find_cache(root, hash)? {
            job.state = "stored".into();
            job.receipt = Some(receipt);
        } else if job.state == "stored" {
            job.state = "pending".into();
            job.receipt = None;
        }
        Ok(job.clone())
    })
}
pub fn pull(root: &Path) -> Result<Option<Job>> {
    with_state(root, |state| {
        for job in state.jobs.values_mut() {
            let hash = job.id.strip_prefix("url_sha256_").context("invalid-job")?;
            if let Some(receipt) = find_cache(root, hash)? {
                job.state = "stored".into();
                job.receipt = Some(receipt);
                continue;
            }
            if job.state == "stored" {
                job.state = "pending".into();
                job.receipt = None;
            }
            if job.state == "failed"
                && job.resource.error.as_deref() == Some("network")
                && job.lease_until <= now()
            {
                job.state = "pending".into();
                job.lease = None;
            }
            if job.state != "pending" && job.state != "downloading" {
                continue;
            }
            if job.lease.is_some() && job.lease_until > now() {
                continue;
            }
            // A new lease starts a fresh response; no unverified cross-response splice.
            job.lease = Some(Uuid::new_v4().to_string());
            job.lease_until = now() + LEASE_MS;
            job.state = "downloading".into();
            job.offset = 0;
            let path = part_path(root, &job.id)?;
            if path.exists() {
                fs::remove_file(path)?;
            }
            return Ok(Some(job.clone()));
        }
        Ok(None)
    })
}
fn leased<'a>(state: &'a mut State, id: &str, lease: &str) -> Result<&'a mut Job> {
    let job = state.jobs.get_mut(id).context("unknown-job")?;
    ensure!(
        job.lease.as_deref() == Some(lease) && job.lease_until >= now(),
        "lease-expired"
    );
    job.lease_until = now() + LEASE_MS;
    Ok(job)
}
pub fn status(root: &Path, id: &str) -> Result<Job> {
    with_state(root, |state| {
        state.jobs.get(id).cloned().context("unknown-job")
    })
}
pub fn append(root: &Path, id: &str, lease: &str, offset: u64, bytes: &[u8]) -> Result<u64> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= CHUNK_MAX_BYTES,
        "invalid-chunk"
    );
    with_state(root, |state| {
        let job = leased(state, id, lease)?;
        let path = part_path(root, id)?;
        let mut prefix = Vec::new();
        if offset > 0 && path.exists() {
            File::open(&path)?.take(8192).read_to_end(&mut prefix)?;
        } else {
            prefix.extend_from_slice(&bytes[..bytes.len().min(8192)]);
        }
        let video = infer::get(&prefix).is_some_and(|kind| kind.mime_type() == "video/mp4");
        let limit = if video {
            VIDEO_MAX_BYTES
        } else {
            IMAGE_MAX_BYTES
        };
        let end = offset
            .checked_add(bytes.len() as u64)
            .context("invalid-offset")?;
        if end > limit {
            job.state = "unsupported".into();
            job.resource.error = Some(if video { "video-too-large" } else { "format" }.into());
            let path = part_path(root, id)?;
            if path.exists() {
                fs::remove_file(path)?;
            }
            bail!(if video { "video-too-large" } else { "format" });
        }
        let path = part_path(root, id)?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        if file.metadata()?.len() > job.offset {
            file.set_len(job.offset)?;
        }
        if offset < job.offset {
            ensure!(end <= job.offset, "offset-conflict");
            file.seek(SeekFrom::Start(offset))?;
            let mut existing = vec![0; bytes.len()];
            file.read_exact(&mut existing)?;
            ensure!(existing == bytes, "chunk-conflict");
            return Ok(job.offset);
        }
        ensure!(offset == job.offset, "offset-conflict");
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        job.offset = end;
        Ok(end)
    })
}
pub fn commit(
    root: &Path,
    id: &str,
    lease: &str,
    length: u64,
    expected_hash: &str,
) -> Result<Receipt> {
    with_state(root, |state| {
        let job = state.jobs.get_mut(id).context("unknown-job")?;
        if job.state == "stored" {
            return job.receipt.clone().context("missing-receipt");
        }
        let job = leased(state, id, lease)?;
        ensure!(
            valid_hash(expected_hash) && job.offset == length,
            "invalid-checksum"
        );
        let path = part_path(root, id)?;
        let (extension, mime, bytes) = match sniff(&path) {
            Ok(media) => media,
            Err(error) => {
                let reason = error.to_string();
                let format = [
                    "unsupported-format",
                    "invalid-file",
                    "media-too-large",
                    "video-too-large",
                ]
                .contains(&reason.as_str());
                job.state = if format { "unsupported" } else { "failed" }.into();
                job.resource.error = Some(
                    if reason == "video-too-large" {
                        "video-too-large"
                    } else if format {
                        "format"
                    } else {
                        "storage"
                    }
                    .into(),
                );
                job.offset = 0;
                if path.exists() {
                    fs::remove_file(&path)?;
                }
                return Err(error);
            }
        };
        ensure!(bytes == length, "invalid-length");
        let mut file = File::open(&path)?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0; CHUNK_MAX_BYTES];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let checksum = format!("{:x}", digest.finalize());
        ensure!(checksum == expected_hash, "checksum-mismatch");
        let hash = id.strip_prefix("url_sha256_").context("invalid-job")?;
        if let Some(receipt) = find_cache(root, hash)? {
            fs::remove_file(&path)?;
            job.receipt = Some(receipt.clone());
            job.state = "stored".into();
            return Ok(receipt);
        }
        directory(root, "assets/x")?;
        let name = format!("{id}.{extension}");
        let final_path = safe_path(root, &format!("assets/x/{name}"))?;
        fs::rename(&path, &final_path)?;
        #[cfg(unix)]
        File::open(final_path.parent().context("parent")?)?.sync_all()?;
        let receipt = Receipt {
            name,
            bytes,
            mime,
            sha256: Some(checksum),
        };
        job.receipt = Some(receipt.clone());
        job.state = "stored".into();
        Ok(receipt)
    })
}
pub fn abort(root: &Path, id: &str, lease: &str, reason: &str) -> Result<()> {
    ensure!(
        [
            "network",
            "authentication",
            "source-missing",
            "storage",
            "format",
            "video-too-large"
        ]
        .contains(&reason),
        "invalid-error"
    );
    with_state(root, |state| {
        if state.jobs.get(id).is_some_and(|job| job.state == "stored") {
            return Ok(());
        }
        let job = leased(state, id, lease)?;
        job.state = if reason == "video-too-large" {
            "unsupported"
        } else {
            "failed"
        }
        .into();
        job.resource.error = Some(reason.into());
        let path = part_path(root, id)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        job.offset = 0;
        Ok(())
    })
}
pub fn dispatch(root: &Path, request: &Value) -> Result<Value> {
    let operation = request["op"].as_str().context("invalid-operation")?;
    let text = |key: &str| -> Result<&str> { request[key].as_str().context("invalid-field") };
    match operation {
        "capture.put" => {
            put_capture(root, request["envelope"].clone())?;
            Ok(json!({"queued":true}))
        }
        "work.pull" => Ok(serde_json::to_value(pull(root)?)?),
        "asset.status" => Ok(serde_json::to_value(status(root, text("jobId")?)?)?),
        "asset.append" => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(text("data")?)?;
            let offset = append(
                root,
                text("jobId")?,
                text("lease")?,
                request["offset"].as_u64().context("invalid-offset")?,
                &bytes,
            )?;
            Ok(json!({"offset":offset}))
        }
        "asset.commit" => Ok(serde_json::to_value(commit(
            root,
            text("jobId")?,
            text("lease")?,
            request["bytes"].as_u64().context("invalid-length")?,
            text("sha256")?,
        )?)?),
        "asset.abort" => {
            abort(root, text("jobId")?, text("lease")?, text("reason")?)?;
            Ok(Value::Null)
        }
        _ => bail!("invalid-operation"),
    }
}
