//! Adds "Paste and Match Style" (Cmd+Shift+V) to the Edit menu on macOS.
//!
//! # How it works
//!
//! The menu item's action is the AppKit selector `pasteAsPlainText:`, with a
//! nil target, so macOS delivers it to the focused view. WKWebView handles
//! this selector; Safari's own "Paste and Match Style" item sends the same
//! one:
//! <https://github.com/WebKit/WebKit/blob/85b404d9be36a777d5765440185ace8e2fd7a600/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm#L346>
//!
//! WebKit then reads the clipboard itself and fires a normal DOM `paste`
//! event in the page. That event carries only `text/plain`; the HTML flavor
//! is dropped:
//! <https://github.com/WebKit/WebKit/blob/85b404d9be36a777d5765440185ace8e2fd7a600/Source/WebCore/editing/Editor.cpp#L471-L478>
//!
//! The editor handles it like any other paste and inserts plain text. This
//! module never reads the clipboard and never sends text over IPC.
//!
//! # Why raw AppKit calls instead of Tauri's menu API
//!
//! This is a gap in Tauri's menu layer, not an AppKit limit. AppKit lets any
//! NSMenuItem carry any action selector. muda (the menu library behind
//! Tauri's menu API) exposes only two item kinds, and neither can send a
//! selector of your choice:
//!
//! - custom items always get muda's own `fireMenuItemAction:` selector,
//!   which routes the click back to app code:
//!   <https://github.com/tauri-apps/muda/blob/muda-v0.19.3/src/platform_impl/macos/mod.rs#L834>
//!   (its handler: <https://github.com/tauri-apps/muda/blob/muda-v0.19.3/src/platform_impl/macos/mod.rs#L1034>)
//! - predefined items map to a fixed selector list (`paste:`, `copy:`, ...)
//!   that has no paste-as-plain-text entry:
//!   <https://github.com/tauri-apps/muda/blob/muda-v0.19.3/src/platform_impl/macos/mod.rs#L983>
//!
//! Open upstream requests for more native items:
//! <https://github.com/tauri-apps/muda/issues/83> and
//! <https://github.com/tauri-apps/tauri/issues/2802>.
//!
//! # Why the webview triggers this, and only after the menu is installed
//!
//! The frontend replaces the whole app menu at startup: `installNativeMenu`
//! (`apps/desktop/src/lib/native-menu/menu.ts`) builds its own menu and
//! calls `Menu.setAsAppMenu` from `@tauri-apps/api/menu`
//! (<https://github.com/tauri-apps/tauri/blob/@tauri-apps/api-v2.11.1/packages/api/src/menu/menu.ts#L237>),
//! which installs it as the new `NSApp.mainMenu` on the Rust side
//! (<https://github.com/tauri-apps/tauri/blob/tauri-v2.11.3/crates/tauri/src/app.rs#L961>).
//! Any item added to the menu before that point is thrown away together with
//! the old menu. So `installNativeMenu` invokes this command as its last
//! step, and the item lands in the menu that is actually on screen, the same
//! way that file assigns the NSApp windows/help roles only after install.

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::Sel;
#[cfg(target_os = "macos")]
use objc2::{sel, MainThreadMarker};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem};
#[cfg(target_os = "macos")]
use objc2_foundation::ns_string;

/// Adds "Paste and Match Style" under Edit > Paste in the current app menu.
/// Called by the webview's `installNativeMenu` right after it installs the
/// menu (the module docs explain why the order matters). Safe to call more
/// than once; when the Edit menu cannot be found it logs a warning and
/// changes nothing. A no-op on non-macOS platforms.
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
    if index_of_action(&edit, action).is_some() {
        return;
    }

    let item = NSMenuItem::new(mtm);
    item.setTitle(ns_string!("Paste and Match Style"));
    item.setKeyEquivalent(ns_string!("v"));
    item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Shift);
    // SAFETY: `pasteAsPlainText:` is a valid AppKit selector. The target
    // stays nil, so macOS sends the action to the focused view and enables
    // the item only while that view implements the selector.
    unsafe { item.setAction(Some(action)) };

    match index_of_action(&edit, sel!(paste:)) {
        Some(paste_index) => edit.insertItem_atIndex(&item, paste_index + 1),
        None => edit.addItem(&item),
    }
    tracing::info!("added Paste and Match Style to the Edit menu");
}

/// Index of the first item in `menu` whose action is `action`.
#[cfg(target_os = "macos")]
fn index_of_action(menu: &NSMenu, action: Sel) -> Option<isize> {
    (0..menu.numberOfItems())
        .find(|&index| menu.itemAtIndex(index).and_then(|item| item.action()) == Some(action))
}

/// The Edit submenu has no stable identifier, so find it by its title.
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
