use serde::{Deserialize, Serialize};

/// A `UIKeyModifierFlags` member.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyModifier {
    Command,
    Shift,
    Alternate,
    Control,
}

/// A key the plugin names rather than spells as a character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NamedKey {
    Enter,
    Escape,
    Tab,
    Delete,
    UpArrow,
    DownArrow,
    LeftArrow,
    RightArrow,
}

/// A `UIKeyCommand` input: a named key, or one character. Any other string
/// fails to deserialize, so the request is rejected instead of the key
/// command going missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KeyInput {
    Named(NamedKey),
    Character(char),
}

/// The key equivalent of a `UIKeyCommand`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEquivalent {
    pub input: KeyInput,
    pub modifiers: Vec<KeyModifier>,
}

/// A menu command: chosen from the menu bar or by its key equivalent, it is
/// reported back on the `menuCommand` event with its id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandItem {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_equivalent: Option<KeyEquivalent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuItem {
    Command(CommandItem),
    /// Ends one group of items and starts the next.
    Separator,
}

/// The system's standard menu a section joins.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MenuPlacement {
    Application,
    File,
    Edit,
    View,
    Window,
    Help,
}

/// One menu's worth of items; with no placement, a new top-level menu titled `title`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSection {
    pub title: String,
    pub placement: Option<MenuPlacement>,
    pub items: Vec<MenuItem>,
}

/// `set_menu`'s request: the whole app menu, replacing the previous one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMenuRequest {
    pub sections: Vec<MenuSection>,
}

/// One item of a context menu.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
}

/// `present_context_menu`'s request: the items, and where in the webview (in
/// CSS pixels, which are points there) the menu points at.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentContextMenuRequest {
    pub items: Vec<ContextMenuItem>,
    pub x: f64,
    pub y: f64,
}

/// `present_context_menu`'s response: the chosen item, or `None` when the
/// menu was dismissed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuChoice {
    pub id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_input_takes_a_named_key_or_one_character() {
        let named: KeyInput = serde_json::from_value(json!("upArrow")).unwrap();
        assert_eq!(named, KeyInput::Named(NamedKey::UpArrow));
        let character: KeyInput = serde_json::from_value(json!("\\")).unwrap();
        assert_eq!(character, KeyInput::Character('\\'));
        assert_eq!(serde_json::to_value(named).unwrap(), json!("upArrow"));
        assert_eq!(serde_json::to_value(character).unwrap(), json!("\\"));
    }

    #[test]
    fn key_input_rejects_any_other_string() {
        assert!(serde_json::from_value::<KeyInput>(json!("UIKeyInputUpArrow")).is_err());
        assert!(serde_json::from_value::<KeyInput>(json!("")).is_err());
    }

    #[test]
    fn a_dismissed_context_menu_reaches_the_webview_as_a_null_id() {
        // Swift encodes `ContextMenuChoice(id: nil)` without the key.
        let dismissed: ContextMenuChoice = serde_json::from_value(json!({})).unwrap();
        assert_eq!(dismissed.id, None);
        assert_eq!(
            serde_json::to_value(dismissed).unwrap(),
            json!({ "id": null })
        );
    }
}
