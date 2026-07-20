//! The macOS app menu: Tauri's default menu plus Edit > "Paste and Match
//! Style" (⌘⇧V).
//!
//! WKWebView only performs the editing shortcuts that an app-menu key
//! equivalent routes to it, and Tauri's default menu carries no
//! paste-without-formatting item — so ⌘⇧V reached the webview as a bare
//! keydown with no paste behind it and did nothing (the old Electron app bound
//! the same accelerator to `pasteAndMatchStyle:`). There is no predefined
//! Tauri item for it either, and the webview cannot read the pasteboard
//! reliably itself (WebKit gates `navigator.clipboard`), so the click handler
//! reads the pasteboard here and hands the plain text to the focused window,
//! where the focused editor pastes it without formatting
//! (`paste-and-match-style-bridge.tsx`).

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, Submenu};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Menu id of the "Paste and Match Style" item, matched in [`on_menu_event`].
const PASTE_AND_MATCH_STYLE_ID: &str = "paste-and-match-style";

/// Event carrying the pasteboard's plain text to the focused window. Consumed
/// by `subscribePasteAndMatchStyle` (`@reflect/core`).
const PASTE_AND_MATCH_STYLE_EVENT: &str = "menu:paste-and-match-style";

/// Builds the app menu: Tauri's default with "Paste and Match Style" inserted
/// after Edit > Paste. The default menu gives its Edit submenu no stable id,
/// so it is matched by its (unlocalized) title; if an upstream change ever
/// renames it, the app degrades to the stock menu rather than failing launch.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;

    let Some(edit) = find_edit_submenu(&menu)? else {
        tracing::warn!("no Edit submenu in the default menu; ⌘⇧V paste unavailable");
        return Ok(menu);
    };

    let item = MenuItem::with_id(
        app,
        PASTE_AND_MATCH_STYLE_ID,
        "Paste and Match Style",
        true,
        Some("CmdOrCtrl+Shift+V"),
    )?;
    match paste_item_position(&edit)? {
        Some(position) => edit.insert(&item, position + 1)?,
        None => edit.append(&item)?,
    }

    Ok(menu)
}

fn find_edit_submenu(menu: &Menu<tauri::Wry>) -> tauri::Result<Option<Submenu<tauri::Wry>>> {
    for kind in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = kind {
            if submenu.text()? == "Edit" {
                return Ok(Some(submenu));
            }
        }
    }
    Ok(None)
}

/// Index of the predefined Paste item inside the Edit submenu, so the new
/// item lands directly under it like in every native Edit menu.
fn paste_item_position(edit: &Submenu<tauri::Wry>) -> tauri::Result<Option<usize>> {
    for (position, kind) in edit.items()?.iter().enumerate() {
        if let MenuItemKind::Predefined(item) = kind {
            if item.text()? == "Paste" {
                return Ok(Some(position));
            }
        }
    }
    Ok(None)
}

/// Routes "Paste and Match Style" clicks (menu or ⌘⇧V): read the pasteboard's
/// plain text and target the focused window's webview with it. An empty or
/// non-text pasteboard is a silent no-op, exactly like the native item in
/// other apps.
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() != PASTE_AND_MATCH_STYLE_ID {
        return;
    }
    let text = match app.clipboard().read_text() {
        Ok(text) if !text.is_empty() => text,
        Ok(_) => return,
        Err(error) => {
            tracing::debug!(%error, "pasteboard has no readable text");
            return;
        }
    };
    let Some(label) = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
    else {
        return;
    };
    if let Err(error) = app.emit_to(&label, PASTE_AND_MATCH_STYLE_EVENT, text) {
        tracing::warn!(%error, "forwarding Paste and Match Style failed");
    }
}
