//! Answers the webview's invokes of the [`Core::dispatch`] commands.

use std::collections::HashMap;
use std::sync::Arc;

use reflect_core::{Core, Reply};
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{Manager, Runtime};

use crate::error::AppError;

/// Runs the invoked command on the core's blocking pool and resolves the
/// invoke with its reply.
pub fn handle<R: Runtime>(invoke: Invoke<R>) {
    let Invoke {
        message, resolver, ..
    } = invoke;
    let core = Arc::clone(message.webview().state::<Arc<Core>>().inner());
    let command = message.command().to_owned();
    let (args, body) = match message.payload() {
        InvokeBody::Json(args) => (args.to_string().into_bytes(), None),
        InvokeBody::Raw(body) => (b"{}".to_vec(), Some(body.clone())),
    };
    let headers: HashMap<&str, &str> = message
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.as_str(), value.to_str().ok()?)))
        .collect();
    let headers = serde_json::to_vec(&headers).unwrap_or_default();

    resolver.respond_async_serialized(async move {
        let reply = core
            .spawn_blocking_future({
                let core = Arc::clone(&core);
                async move {
                    core.dispatch(&command, &args, &headers, body.as_deref())
                        .await
                }
            })
            .await
            .map_err(|err| AppError::io(format!("command panicked: {err}")))
            .flatten();
        match reply {
            Ok(Reply::Json(json)) => Ok(InvokeResponseBody::Json(json)),
            Ok(Reply::Bytes(bytes)) => Ok(InvokeResponseBody::Raw(bytes)),
            Err(error) => Err(InvokeError::from(error)),
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use reflect_core::{Core, CoreConfig};
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindow};

    use crate::host::TauriHost;

    fn webview() -> WebviewWindow<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(|invoke| {
                super::handle(invoke);
                true
            })
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let host = Arc::new(TauriHost::new(app.handle().clone()));
        let core = Core::new(CoreConfig::default(), host).expect("core");
        app.manage(Arc::new(core));
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview")
    }

    fn invoke(
        webview: &WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<InvokeResponseBody, Value> {
        tauri::test::get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("url"),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn a_command_resolves_with_its_json_reply() {
        let reply = invoke(&webview(), "embed_status", json!({})).expect("reply");
        let status: Value = reply.deserialize().expect("json");
        assert!(status["status"].is_string());
    }

    #[test]
    fn a_failed_command_rejects_with_kind_and_message() {
        let error = invoke(&webview(), "note_read", json!({ "path": "a.md" }))
            .expect_err("no graph is open");
        assert_eq!(error["kind"], "noGraph");
        assert!(error["message"].is_string());
    }

    #[test]
    fn a_command_with_bad_arguments_rejects_with_a_parse_error() {
        let error = invoke(&webview(), "note_read", json!({})).expect_err("missing arguments");
        assert_eq!(error["kind"], "parse");
    }
}
