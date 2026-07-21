//! Edit > "Paste and Match Style" (Cmd+Shift+V) on the macOS app menu.
//!
//! The item's action is `pasteAsPlainText:`, the responder-chain selector
//! Safari's identical menu item sends. WKWebView implements it (WebKit
//! `WKWebViewMac.mm`), and WebCore answers it by dispatching a real `paste`
//! event whose DataTransfer carries only `text/plain` (`Editor.cpp` builds a
//! plain-text-only `StaticPasteboard` for this command), so the editor's
//! normal paste pipeline sees a paste with no rich flavors and inserts plain
//! text. No pasteboard read here, no IPC payload, no frontend paste code.
//!
//! Neither Tauri's menu API nor `@tauri-apps/api/menu` can express a
//! selector-backed item (custom items only call back into app code), so the
//! webview's `installNativeMenu` (`lib/native-menu/menu.ts`) invokes this
//! command after `setAsAppMenu`, and the item is added with AppKit directly.
//! The timing matters: `setAsAppMenu` clones each submenu's NSMenu and
//! replaces the whole main menu, so the item must be patched into the
//! installed instance afterwards, exactly like the NSApp window/help roles.
//! (Anything added to the menu Tauri installs at startup is clobbered the
//! moment the webview installs its own menu.)

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::{sel, MainThreadMarker, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem};
#[cfg(target_os = "macos")]
use objc2_foundation::ns_string;

/// Patches "Paste and Match Style" into the installed app menu, directly
/// under Edit > Paste. Idempotent; a no-op off macOS. When the Edit menu
/// cannot be found the app keeps its current menu and only warns.
#[tauri::command]
pub fn menu_install_paste_and_match_style(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.run_on_main_thread(install_paste_and_match_style) {
        tracing::warn!(%error, "Paste and Match Style install could not reach the main thread");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn install_paste_and_match_style() {
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!("Paste and Match Style skipped: not on the main thread");
        return;
    };
    let Some(main_menu) = NSApplication::sharedApplication(mtm).mainMenu() else {
        tracing::warn!("Paste and Match Style skipped: no app menu installed");
        return;
    };
    let Some(edit) = find_edit_menu(&main_menu) else {
        tracing::warn!("Paste and Match Style skipped: no Edit menu found");
        return;
    };

    let action = sel!(pasteAsPlainText:);
    // SAFETY: a nil target and a valid AppKit editing selector.
    if unsafe { edit.indexOfItemWithTarget_andAction(None, Some(action)) } >= 0 {
        return;
    }

    // SAFETY: the title and key equivalent are static strings; the selector
    // is valid. A nil target sends the action down the responder chain, so
    // AppKit enables the item only while the focused view implements it.
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            ns_string!("Paste and Match Style"),
            Some(action),
            ns_string!("v"),
        )
    };
    item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Shift);

    // SAFETY: `paste:` is the predefined Paste item's selector.
    let paste_index = unsafe { edit.indexOfItemWithTarget_andAction(None, Some(sel!(paste:))) };
    if paste_index >= 0 {
        edit.insertItem_atIndex(&item, paste_index + 1);
    } else {
        edit.addItem(&item);
    }
    tracing::info!("added Paste and Match Style to the Edit menu");
}

/// The Edit submenu carries no stable identifier, so it is located by its
/// (unlocalized) title.
#[cfg(target_os = "macos")]
fn find_edit_menu(main_menu: &NSMenu) -> Option<Retained<NSMenu>> {
    for index in 0..main_menu.numberOfItems() {
        let Some(submenu) = main_menu.itemAtIndex(index).and_then(|item| item.submenu()) else {
            continue;
        };
        if submenu.title().to_string() == "Edit" {
            return Some(submenu);
        }
    }
    None
}
