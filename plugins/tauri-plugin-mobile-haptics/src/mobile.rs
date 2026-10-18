use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_haptics);

/// Registers the native half. Android is a Plan 19 fast-follow, gated the
/// same way as `tauri-plugin-keyboard`: no Kotlin implementation exists yet,
/// so an Android build fails here loudly instead of shipping silent taps.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Haptics<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-mobile-haptics has no Android implementation yet");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_haptics)?;
    Ok(Haptics(handle))
}

/// Access to the haptics APIs.
pub struct Haptics<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Haptics<R> {
    /// Fire a light impact haptic (`UIImpactFeedbackGenerator` on iOS).
    pub fn impact_light(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("impactLight", ())
            .map_err(Into::into)
    }
}
