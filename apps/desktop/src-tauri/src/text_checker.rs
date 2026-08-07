//! Turns on the macOS webview's spell-check underlines and turns off its
//! smart punctuation, by writing WebKit's per-app text-checker defaults.
//!
//! WKWebView's "check spelling while typing" (the red underline) is gated on
//! the app's own NSUserDefaults: WebKit treats an absent
//! `WebContinuousSpellCheckingEnabled` key as off:
//! https://github.com/WebKit/WebKit/blob/85b404d9be36a777d5765440185ace8e2fd7a600/Source/WebKit/UIProcess/mac/TextCheckerMac.mm#L113
//! Nothing in Tauri or wry writes that key, so on a fresh install the editor
//! never underlines a misspelling, whatever the in-app "Spell check" setting
//! (which drives the DOM `spellcheck` attribute, a second, per-element gate)
//! says.
//!
//! Smart quote/dash substitution is gated differently: an absent key falls
//! back to the system keyboard setting ("Use smart quotes and dashes"):
//! https://github.com/WebKit/WebKit/blob/85b404d9be36a777d5765440185ace8e2fd7a600/Source/WebKit/UIProcess/mac/TextCheckerMac.mm#L71-L87
//! With it on, WebKit rewrites straight punctuation near the caret, including
//! Markdown the editor needs literal (the `-->` closing an image sizing
//! comment, `---` fences). meowdown ships its own undoable, code-span-aware
//! substitutions, so the system flavor is all downside here; pin it off.
//!
//! Everything is written once, guarded by a marker key: the webview's native
//! context menu (Spelling and Grammar, Substitutions) toggles these same keys
//! and persists the choice:
//! https://github.com/WebKit/WebKit/blob/85b404d9be36a777d5765440185ace8e2fd7a600/Source/WebKit/UIProcess/mac/TextCheckerMac.mm#L191
//! so a choice the user makes there must beat ours on every later launch.
//! MarkEdit (also WKWebView) ships the same write-once pattern:
//! https://github.com/MarkEdit-app/MarkEdit/blob/7c047c55e12cf747f872abfcf23d7208ee3b4a50/MarkEditKit/Sources/Extensions/UserDefaults+Extension.swift#L14

use objc2_foundation::{ns_string, NSUserDefaults};

/// Writes the text-checker defaults unless this build flavor's defaults
/// domain shows they were written before. Runs in `run()` before the first
/// webview is created, so WebKit's one-time lazy read of these keys in the
/// UI process cannot happen first.
pub fn apply_defaults_once() {
    let defaults = NSUserDefaults::standardUserDefaults();
    if defaults.boolForKey(ns_string!("ReflectTextCheckerDefaultsApplied")) {
        return;
    }
    // `NSAllowContinuousSpellChecking` is an extra allow-gate on the same
    // WebKit path; absent means allowed, but a global-domain override would
    // silently win, so state it.
    defaults.setBool_forKey(true, ns_string!("NSAllowContinuousSpellChecking"));
    defaults.setBool_forKey(true, ns_string!("WebContinuousSpellCheckingEnabled"));
    defaults.setBool_forKey(false, ns_string!("WebAutomaticQuoteSubstitutionEnabled"));
    defaults.setBool_forKey(false, ns_string!("WebAutomaticDashSubstitutionEnabled"));
    defaults.setBool_forKey(true, ns_string!("ReflectTextCheckerDefaultsApplied"));
}
