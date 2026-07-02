use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_keyboard);

/// Registers the native half. Android is a Plan 19 fast-follow: the Kotlin
/// class does not exist yet, so an Android build fails here loudly instead
/// of shipping a silently event-less keyboard bridge.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Keyboard<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-keyboard has no Android implementation yet (Plan 19 step 12)");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_keyboard)?;
    Ok(Keyboard(handle))
}

/// Access to the keyboard APIs.
pub struct Keyboard<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Keyboard<R> {
    /// The keyboard's current state (see `KeyboardState`); live changes
    /// arrive on the plugin's `keyboardChange` event instead.
    pub fn current_height(&self) -> crate::Result<KeyboardState> {
        self.0
            .run_mobile_plugin("currentHeight", ())
            .map_err(Into::into)
    }

    /// Fire a light impact haptic (`UIImpactFeedbackGenerator` on iOS).
    pub fn impact_light(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("impactLight", ())
            .map_err(Into::into)
    }
}
