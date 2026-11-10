//! A C ABI over [`reflect_core::Core`]. The host creates one core with
//! [`reflect_core_new`], sends commands with [`reflect_core_dispatch`], and
//! frees the core with [`reflect_core_free`].
//!
//! Contract:
//!
//! - Every string is UTF-8. Memory that one side allocates is freed only by
//!   that side: the host frees Rust strings with [`reflect_core_string_free`].
//! - `reflect_core_dispatch` returns at once. The command runs on the core
//!   runtime, and `reply` runs exactly once on a Rust thread.
//! - `on_event` and `on_open_url` run on a Rust thread. `on_main` hands the
//!   host a task that the host runs on its main thread with
//!   [`reflect_core_run_task`].
//! - No callback starts after `reflect_core_free` returns, and a callback that
//!   is running when it is called finishes before it returns. A reply that is
//!   not sent by then is never sent. Do not call `reflect_core_free` from
//!   inside a callback.
//! - A Rust panic does not cross the ABI: a panicking command replies with
//!   the error `{"kind":"unknown"}`.

use std::any::Any;
use std::ffi::{CStr, CString, c_char, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::pin::Pin;
use std::ptr;
use std::sync::{Arc, PoisonError, RwLock};
use std::task::{Context, Poll};

use reflect_core::{Core, CoreConfig, Host, Reply};
use reflect_types::{AppError, AppResult};

/// The reply status of a JSON result in `json`.
pub const REFLECT_STATUS_JSON: i32 = 0;
/// The reply status of a byte result in `bytes`.
pub const REFLECT_STATUS_BYTES: i32 = 1;
/// The reply status of an error: `json` is `{"kind":...,"message":...}`.
pub const REFLECT_STATUS_ERROR: i32 = 2;

/// Receives the result of one dispatch. `status` is one of the
/// `REFLECT_STATUS_*` values. The pointers are valid only during the call.
pub type ReflectReplyFn = Option<
    unsafe extern "C" fn(
        ctx: *mut c_void,
        status: i32,
        json: *const u8,
        json_len: usize,
        bytes: *const u8,
        bytes_len: usize,
    ),
>;

/// Receives one event: a NUL-terminated name and a JSON payload. The
/// pointers are valid only during the call.
pub type ReflectEventFn = Option<
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char, json: *const u8, json_len: usize),
>;

/// Receives a task that the host passes to `reflect_core_run_task` on its
/// main thread.
pub type ReflectMainFn = Option<unsafe extern "C" fn(ctx: *mut c_void, task: *mut c_void)>;

/// Asks the host to open a NUL-terminated URL or absolute file path with the
/// system handler. It returns whether the host accepted it. The pointer is
/// valid only during the call.
pub type ReflectOpenUrlFn =
    Option<unsafe extern "C" fn(ctx: *mut c_void, url: *const c_char) -> bool>;

/// A core created by `reflect_core_new`.
pub struct ReflectCore {
    core: CoreRef,
    gate: Arc<Gate>,
}

type MainTask = Box<dyn FnOnce() + Send>;

/// Creates a core. `config_json` is a NUL-terminated JSON object, or NULL
/// for an empty one, with the optional string keys `documentDir`,
/// `appDataDir` (or `dataDir`) and `userAgent`; other keys are ignored. `ctx` is passed to `on_event`, `on_main` and
/// `on_open_url`. On failure it returns NULL and, when `error_out` is not
/// NULL, stores an error JSON `{"kind":...,"message":...}` there for
/// `reflect_core_string_free`.
///
/// # Safety
///
/// `config_json` is NULL or a NUL-terminated string. `error_out` is NULL or
/// points to writable memory. `ctx` stays valid until `reflect_core_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reflect_core_new(
    config_json: *const c_char,
    on_event: ReflectEventFn,
    on_main: ReflectMainFn,
    on_open_url: ReflectOpenUrlFn,
    ctx: *mut c_void,
    error_out: *mut *mut c_char,
) -> *mut ReflectCore {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let config = unsafe { read_config(config_json) }?;
        let gate = Arc::new(Gate::new());
        let host = Arc::new(FfiHost {
            on_event,
            on_main,
            on_open_url,
            ctx: Ctx(ctx),
            gate: Arc::clone(&gate),
        });
        let core = Core::new(config, host)?;
        Ok(ReflectCore {
            core: CoreRef(Some(Arc::new(core))),
            gate,
        })
    }))
    .unwrap_or_else(|payload| Err(panic_error(payload)));
    match result {
        Ok(core) => Box::into_raw(Box::new(core)),
        Err(error) => {
            if !error_out.is_null() {
                let json = CString::new(error_json(&error)).unwrap_or_default();
                unsafe { *error_out = json.into_raw() };
            }
            ptr::null_mut()
        }
    }
}

/// Runs `command` and calls `reply` once with the result. `args_json` is a
/// JSON object of camelCase arguments; empty arguments are `{}`.
/// `headers_json` is a JSON object of lowercase request header names and
/// values; empty headers are `{}`. `body` is the raw request body, or NULL for none. Each pointer may be
/// NULL when its length is 0. The function copies every input before it
/// returns.
///
/// # Safety
///
/// `core` comes from `reflect_core_new` and is not freed. `command` is a
/// NUL-terminated string. Each other pointer is NULL or points to its length
/// in bytes. `reply_ctx` stays valid until `reply` runs.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn reflect_core_dispatch(
    core: *const ReflectCore,
    command: *const c_char,
    args_json: *const u8,
    args_len: usize,
    headers_json: *const u8,
    headers_len: usize,
    body: *const u8,
    body_len: usize,
    reply: ReflectReplyFn,
    reply_ctx: *mut c_void,
) {
    let target = ReplyTarget {
        reply,
        ctx: Ctx(reply_ctx),
    };
    let started = catch_unwind(AssertUnwindSafe(|| -> AppResult<()> {
        let ffi = unsafe { core.as_ref() }.ok_or_else(|| AppError::io("core is NULL"))?;
        let command = unsafe { read_str(command) }?;
        let mut args = unsafe { bytes(args_json, args_len) }.to_vec();
        if args.is_empty() {
            args = b"{}".to_vec();
        }
        let mut headers = unsafe { bytes(headers_json, headers_len) }.to_vec();
        if headers.is_empty() {
            headers = b"{}".to_vec();
        }
        let body = (!body.is_null()).then(|| unsafe { bytes(body, body_len) }.to_vec());
        let core = ffi.core.clone();
        spawn_reply(
            ffi,
            async move {
                core.arc()
                    .dispatch(&command, &args, &headers, body.as_deref())
                    .await
            },
            target,
        );
        Ok(())
    }))
    .unwrap_or_else(|payload| Err(panic_error(payload)));
    if let Err(error) = started {
        target.send(Err(error));
    }
}

/// Runs a task that `on_main` received. NULL does nothing.
///
/// # Safety
///
/// `task` comes from `on_main` and has not run yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reflect_core_run_task(task: *mut c_void) {
    if task.is_null() {
        return;
    }
    let task = unsafe { Box::from_raw(task.cast::<MainTask>()) };
    let _ = catch_unwind(AssertUnwindSafe(task));
}

/// Frees a string that Rust allocated. NULL does nothing.
///
/// # Safety
///
/// `string` comes from this library and is not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reflect_core_string_free(string: *mut c_char) {
    if !string.is_null() {
        drop(unsafe { CString::from_raw(string) });
    }
}

/// Frees a core. It returns after every running callback finishes, and no
/// callback starts afterwards. Running commands finish, but their replies
/// are not sent. NULL does nothing.
///
/// # Safety
///
/// `core` comes from `reflect_core_new` and is not freed yet. The call is
/// not made from inside a callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reflect_core_free(core: *mut ReflectCore) {
    if core.is_null() {
        return;
    }
    let core = unsafe { Box::from_raw(core) };
    let _ = catch_unwind(AssertUnwindSafe(move || {
        core.gate.close();
        drop(core);
    }));
}

/// Runs `work` on a blocking-pool thread of the core runtime and sends its
/// result, or an `unknown` error when it panics, to `target` while the gate
/// is open.
fn spawn_reply<F>(ffi: &ReflectCore, work: F, target: ReplyTarget)
where
    F: Future<Output = AppResult<Reply>> + Send + 'static,
{
    let gate = Arc::clone(&ffi.gate);
    drop(ffi.core.arc().spawn_blocking_future(async move {
        let result = CatchUnwind(Box::pin(work))
            .await
            .unwrap_or_else(|payload| Err(panic_error(payload)));
        gate.run(|| {
            let _ = catch_unwind(AssertUnwindSafe(|| target.send(result)));
        });
    }));
}

/// Polls a future and returns the payload of a panic during a poll as `Err`.
struct CatchUnwind<F>(Pin<Box<F>>);

impl<F: Future> Future for CatchUnwind<F> {
    type Output = Result<F::Output, Box<dyn Any + Send>>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let inner = self.get_mut().0.as_mut();
        match catch_unwind(AssertUnwindSafe(|| inner.poll(cx))) {
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(payload)),
        }
    }
}

/// A strong reference to a [`Core`]. The last one drops the core on a new
/// thread, because dropping a `Core` shuts down its runtime and tokio rejects
/// that on a runtime thread.
#[derive(Clone)]
struct CoreRef(Option<Arc<Core>>);

impl CoreRef {
    fn arc(&self) -> &Arc<Core> {
        self.0
            .as_ref()
            .expect("a CoreRef holds its core until it drops")
    }
}

impl Drop for CoreRef {
    fn drop(&mut self) {
        if let Some(core) = self.0.take().and_then(Arc::into_inner) {
            let _ = std::thread::Builder::new()
                .name("reflect-core-drop".into())
                .spawn(move || drop(core));
        }
    }
}

/// Lets callbacks run until [`Gate::close`]. `close` waits for running
/// callbacks and blocks all later ones.
struct Gate {
    open: RwLock<bool>,
}

impl Gate {
    fn new() -> Self {
        Self {
            open: RwLock::new(true),
        }
    }

    /// Runs `callback` when the gate is open and returns whether it ran.
    fn run(&self, callback: impl FnOnce()) -> bool {
        let open = self.open.read().unwrap_or_else(PoisonError::into_inner);
        if *open {
            callback();
        }
        *open
    }

    fn close(&self) {
        *self.open.write().unwrap_or_else(PoisonError::into_inner) = false;
    }
}

/// A foreign context pointer that Rust carries across threads.
#[derive(Clone, Copy)]
struct Ctx(*mut c_void);

// SAFETY: the host promises that the pointer is usable from any thread.
unsafe impl Send for Ctx {}
unsafe impl Sync for Ctx {}

impl Ctx {
    fn get(self) -> *mut c_void {
        self.0
    }
}

#[derive(Clone, Copy)]
struct ReplyTarget {
    reply: ReflectReplyFn,
    ctx: Ctx,
}

impl ReplyTarget {
    fn send(self, result: AppResult<Reply>) {
        let Some(reply) = self.reply else {
            return;
        };
        let ctx = self.ctx.get();
        match result {
            Ok(Reply::Json(json)) => unsafe {
                reply(
                    ctx,
                    REFLECT_STATUS_JSON,
                    json.as_ptr(),
                    json.len(),
                    ptr::null(),
                    0,
                );
            },
            Ok(Reply::Bytes(bytes)) => unsafe {
                reply(
                    ctx,
                    REFLECT_STATUS_BYTES,
                    ptr::null(),
                    0,
                    bytes.as_ptr(),
                    bytes.len(),
                );
            },
            Err(error) => {
                let json = error_json(&error);
                unsafe {
                    reply(
                        ctx,
                        REFLECT_STATUS_ERROR,
                        json.as_ptr(),
                        json.len(),
                        ptr::null(),
                        0,
                    )
                };
            }
        }
    }
}

/// A [`Host`] that calls the callbacks given to `reflect_core_new`.
struct FfiHost {
    on_event: ReflectEventFn,
    on_main: ReflectMainFn,
    on_open_url: ReflectOpenUrlFn,
    ctx: Ctx,
    gate: Arc<Gate>,
}

impl Host for FfiHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let Some(on_event) = self.on_event else {
            return;
        };
        let Ok(name) = CString::new(event) else {
            return;
        };
        let json = payload.to_string();
        let ctx = self.ctx;
        self.gate
            .run(|| unsafe { on_event(ctx.get(), name.as_ptr(), json.as_ptr(), json.len()) });
    }

    fn run_on_main(&self, task: MainTask) -> AppResult<()> {
        let on_main = self
            .on_main
            .ok_or_else(|| AppError::io("the host has no main-thread callback"))?;
        let task = Box::into_raw(Box::new(task)).cast::<c_void>();
        let ctx = self.ctx;
        if self.gate.run(|| unsafe { on_main(ctx.get(), task) }) {
            Ok(())
        } else {
            drop(unsafe { Box::from_raw(task.cast::<MainTask>()) });
            Err(AppError::io("the core is freed"))
        }
    }

    fn open_url(&self, url: &str) -> AppResult<()> {
        let on_open_url = self
            .on_open_url
            .ok_or_else(|| AppError::io(format!("this host cannot open {url}")))?;
        let c_url = CString::new(url)
            .map_err(|_| AppError::parse(format!("the URL has a NUL byte: {url}")))?;
        let ctx = self.ctx;
        let mut accepted = false;
        if !self
            .gate
            .run(|| accepted = unsafe { on_open_url(ctx.get(), c_url.as_ptr()) })
        {
            return Err(AppError::io("the core is freed"));
        }
        if accepted {
            Ok(())
        } else {
            Err(AppError::io(format!("the host could not open {url}")))
        }
    }

    #[cfg(not(target_os = "ios"))]
    fn reveal_path(&self, path: &std::path::Path) -> AppResult<()> {
        Err(AppError::io(format!(
            "this host cannot reveal {}",
            path.display()
        )))
    }
}

/// The keys of `config_json` that map to [`CoreConfig`]. Other keys are
/// ignored.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigJson {
    #[serde(alias = "dataDir")]
    app_data_dir: Option<PathBuf>,
    document_dir: Option<PathBuf>,
    user_agent: Option<String>,
}

/// Parses `config_json`, a JSON object.
unsafe fn read_config(config_json: *const c_char) -> AppResult<CoreConfig> {
    if config_json.is_null() {
        return Ok(CoreConfig::default());
    }
    let raw = unsafe { CStr::from_ptr(config_json) }.to_bytes();
    let config: ConfigJson = serde_json::from_slice(raw)
        .map_err(|err| AppError::parse(format!("invalid core config: {err}")))?;
    Ok(CoreConfig {
        app_data_dir: config.app_data_dir,
        document_dir: config.document_dir,
        user_agent: config.user_agent.unwrap_or_default(),
    })
}

unsafe fn read_str(string: *const c_char) -> AppResult<String> {
    if string.is_null() {
        return Err(AppError::parse("command is NULL"));
    }
    unsafe { CStr::from_ptr(string) }
        .to_str()
        .map(str::to_owned)
        .map_err(|err| AppError::parse(format!("command is not UTF-8: {err}")))
}

/// Borrows `len` bytes at `ptr`. A NULL `ptr` or a zero `len` is an empty
/// slice, because `slice::from_raw_parts` requires a non-NULL pointer.
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

fn panic_error(payload: Box<dyn Any + Send>) -> AppError {
    let message = payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default();
    AppError::Unknown {
        message: format!("panic: {message}"),
    }
}

fn error_json(error: &AppError) -> String {
    serde_json::to_string(error)
        .unwrap_or_else(|_| r#"{"kind":"unknown","message":"unserializable error"}"#.to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;

    /// Collects callback calls and wakes waiters.
    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<(String, Vec<u8>)>>,
        changed: Condvar,
    }

    impl Recorder {
        fn push(&self, label: String, data: Vec<u8>) {
            self.calls.lock().unwrap().push((label, data));
            self.changed.notify_all();
        }

        /// The first call, or `None` when none comes within `timeout`.
        fn first(&self, timeout: Duration) -> Option<(String, Vec<u8>)> {
            let calls = self.calls.lock().unwrap();
            let (calls, _) = self
                .changed
                .wait_timeout_while(calls, timeout, |calls| calls.is_empty())
                .unwrap();
            calls.first().cloned()
        }

        fn ctx(&self) -> *mut c_void {
            ptr::from_ref(self).cast_mut().cast()
        }
    }

    unsafe extern "C" fn record_reply(
        ctx: *mut c_void,
        status: i32,
        json: *const u8,
        json_len: usize,
        data: *const u8,
        data_len: usize,
    ) {
        let recorder = unsafe { &*ctx.cast::<Recorder>() };
        let payload = if status == REFLECT_STATUS_BYTES {
            unsafe { bytes(data, data_len) }
        } else {
            unsafe { bytes(json, json_len) }
        };
        recorder.push(status.to_string(), payload.to_vec());
    }

    unsafe extern "C" fn record_event(
        ctx: *mut c_void,
        name: *const c_char,
        json: *const u8,
        json_len: usize,
    ) {
        let recorder = unsafe { &*ctx.cast::<Recorder>() };
        let name = unsafe { CStr::from_ptr(name) }.to_str().unwrap().to_owned();
        recorder.push(name, unsafe { bytes(json, json_len) }.to_vec());
    }

    /// Records the URL as an `open-url` call and refuses URLs that start
    /// with `refuse:`.
    unsafe extern "C" fn record_open_url(ctx: *mut c_void, url: *const c_char) -> bool {
        let recorder = unsafe { &*ctx.cast::<Recorder>() };
        let url = unsafe { CStr::from_ptr(url) }.to_bytes().to_vec();
        let accepted = !url.starts_with(b"refuse:");
        recorder.push("open-url".to_owned(), url);
        accepted
    }

    unsafe extern "C" fn run_main_inline(_ctx: *mut c_void, task: *mut c_void) {
        unsafe { reflect_core_run_task(task) };
    }

    const WAIT: Duration = Duration::from_secs(10);

    fn new_core(events: &Recorder) -> *mut ReflectCore {
        let config = CString::new(r#"{"appVersion":"1.0.0","documentDir":"/tmp/docs"}"#).unwrap();
        let mut error = ptr::null_mut();
        let core = unsafe {
            reflect_core_new(
                config.as_ptr(),
                Some(record_event),
                Some(run_main_inline),
                Some(record_open_url),
                events.ctx(),
                &mut error,
            )
        };
        assert!(!core.is_null() && error.is_null());
        core
    }

    fn dispatch(core: *mut ReflectCore, command: &str, replies: &Recorder) {
        let command = CString::new(command).unwrap();
        unsafe {
            reflect_core_dispatch(
                core,
                command.as_ptr(),
                ptr::null(),
                0,
                ptr::null(),
                0,
                ptr::null(),
                0,
                Some(record_reply),
                replies.ctx(),
            );
        }
    }

    fn error_reply(replies: &Recorder) -> Value {
        let (status, json) = replies.first(WAIT).expect("a reply");
        assert_eq!(status, REFLECT_STATUS_ERROR.to_string());
        serde_json::from_slice(&json).unwrap()
    }

    #[test]
    fn dispatch_with_null_args_replies_json() {
        let events = Recorder::default();
        let replies = Recorder::default();
        let core = new_core(&events);
        dispatch(core, "settings_load", &replies);
        let (status, json) = replies.first(WAIT).expect("a reply");
        assert_eq!(
            status,
            REFLECT_STATUS_JSON.to_string(),
            "{}",
            String::from_utf8_lossy(&json)
        );
        assert!(serde_json::from_slice::<Value>(&json).unwrap().is_object());
        unsafe { reflect_core_free(core) };
    }

    #[test]
    fn unknown_command_replies_error() {
        let events = Recorder::default();
        let replies = Recorder::default();
        let core = new_core(&events);
        dispatch(core, "no_such_command", &replies);
        let error = error_reply(&replies);
        assert_eq!(error["kind"], "notFound");
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("no_such_command")
        );
        unsafe { reflect_core_free(core) };
    }

    #[test]
    fn invalid_config_returns_error() {
        let config = CString::new("[]").unwrap();
        let mut error = ptr::null_mut();
        let core = unsafe {
            reflect_core_new(
                config.as_ptr(),
                None,
                None,
                None,
                ptr::null_mut(),
                &mut error,
            )
        };
        assert!(core.is_null());
        let json: Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(error) }.to_bytes()).unwrap();
        assert_eq!(json["kind"], "parse");
        unsafe { reflect_core_string_free(error) };
    }

    #[test]
    fn config_json_fills_core_config() {
        let read = |json: &str| {
            let json = CString::new(json).unwrap();
            unsafe { read_config(json.as_ptr()) }.unwrap()
        };
        let config = read(
            r#"{"documentDir":"/d","dataDir":"/a","userAgent":"Reflect/1.2.3","flavor":"dev"}"#,
        );
        assert_eq!(config.document_dir, Some(PathBuf::from("/d")));
        assert_eq!(config.app_data_dir, Some(PathBuf::from("/a")));
        assert_eq!(config.user_agent, "Reflect/1.2.3");
        assert_eq!(
            read(r#"{"appDataDir":"/b"}"#).app_data_dir,
            Some(PathBuf::from("/b"))
        );
        let empty = unsafe { read_config(ptr::null()) }.unwrap();
        assert_eq!(empty.document_dir, None);
        assert_eq!(empty.user_agent, "");
    }

    #[test]
    fn panicking_work_replies_unknown() {
        let events = Recorder::default();
        let replies = Recorder::default();
        let core = new_core(&events);
        let target = ReplyTarget {
            reply: Some(record_reply),
            ctx: Ctx(replies.ctx()),
        };
        spawn_reply(unsafe { &*core }, async { panic!("boom") }, target);
        let error = error_reply(&replies);
        assert_eq!(error["kind"], "unknown");
        assert_eq!(error["message"], "panic: boom");
        unsafe { reflect_core_free(core) };
    }

    #[test]
    fn host_calls_event_and_main_callbacks() {
        let events = Recorder::default();
        let core = new_core(&events);
        let host_core = unsafe { &*core }.core.clone();
        host_core.arc().host().emit("test:event", json!({ "a": 1 }));
        assert_eq!(
            events.first(WAIT),
            Some(("test:event".to_owned(), br#"{"a":1}"#.to_vec()))
        );

        let ran = Arc::new(AtomicBool::new(false));
        let task_ran = Arc::clone(&ran);
        host_core
            .arc()
            .host()
            .run_on_main(Box::new(move || task_ran.store(true, Ordering::SeqCst)))
            .unwrap();
        assert!(ran.load(Ordering::SeqCst));
        unsafe { reflect_core_free(core) };
    }

    #[test]
    fn host_open_url_calls_the_callback() {
        let events = Recorder::default();
        let core = new_core(&events);
        let host_core = unsafe { &*core }.core.clone();
        host_core
            .arc()
            .host()
            .open_url("https://reflect.app")
            .unwrap();
        assert_eq!(
            events.first(WAIT),
            Some(("open-url".to_owned(), b"https://reflect.app".to_vec()))
        );
        let refused = host_core.arc().host().open_url("refuse:x").unwrap_err();
        assert_eq!(refused.message(), "the host could not open refuse:x");
        unsafe { reflect_core_free(core) };
        assert!(
            host_core
                .arc()
                .host()
                .open_url("https://reflect.app")
                .is_err()
        );
    }

    #[test]
    fn blocking_calls_do_not_stall_other_calls() {
        let events = Recorder::default();
        let replies = Recorder::default();
        let core = new_core(&events);
        let release = Arc::new(AtomicBool::new(false));
        for _ in 0..4 {
            let release = Arc::clone(&release);
            let target = ReplyTarget {
                reply: None,
                ctx: Ctx(ptr::null_mut()),
            };
            spawn_reply(
                unsafe { &*core },
                async move {
                    while !release.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Ok(Reply::Json("null".to_owned()))
                },
                target,
            );
        }
        dispatch(core, "settings_load", &replies);
        let reply = replies.first(WAIT);
        release.store(true, Ordering::SeqCst);
        assert_eq!(reply.expect("a reply").0, REFLECT_STATUS_JSON.to_string());
        unsafe { reflect_core_free(core) };
    }

    #[test]
    fn nothing_fires_after_free() {
        let events = Recorder::default();
        let replies = Recorder::default();
        let core = new_core(&events);
        let host_core = unsafe { &*core }.core.clone();
        let release = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let target = ReplyTarget {
            reply: Some(record_reply),
            ctx: Ctx(replies.ctx()),
        };
        let (work_release, work_done) = (Arc::clone(&release), Arc::clone(&done));
        spawn_reply(
            unsafe { &*core },
            async move {
                while !work_release.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                work_done.store(true, Ordering::SeqCst);
                Ok(Reply::Json("null".to_owned()))
            },
            target,
        );

        unsafe { reflect_core_free(core) };
        release.store(true, Ordering::SeqCst);
        while !done.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        host_core.arc().host().emit("test:event", json!(null));
        let main = host_core.arc().host().run_on_main(Box::new(|| {}));

        assert!(main.is_err());
        assert_eq!(replies.first(Duration::from_millis(200)), None);
        assert_eq!(events.first(Duration::ZERO), None);
    }
}
