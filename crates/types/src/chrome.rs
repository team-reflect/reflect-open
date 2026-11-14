//! The chrome protocol of the iOS app: the state the page posts to the Swift
//! shell, and the intents the shell sends back (`chrome:intent`).

use serde::{Deserialize, Serialize};

/// A message the page posts to the shell.
// Only the TypeScript and Swift code builds it: Rust holds the type to
// generate theirs.
#[allow(clippy::large_enum_variant)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChromeMessage {
    /// The chrome state, after every change. specta-swift names its payload
    /// `ChromeMessageStateData`.
    State {
        /// Grows with every state of one document.
        generation: isize,
        /// The history entry the state describes; intents echo it. A surface
        /// outside the router uses -1.
        entry_id: isize,
        chrome: ChromeKind,
        /// The kind of the route on screen, for logs.
        route_kind: Option<String>,
        /// The tab the page shows.
        tab: ChromeTab,
        /// The shell shows a back button before the `leading` buttons.
        can_back: bool,
        /// The buttons in the top-left corner, after the back button.
        leading: Vec<BarButton>,
        /// The buttons in the top-right corner.
        trailing: Vec<BarButton>,
        keyboard_visible: bool,
        /// A web drawer is open: the shell hides its bars.
        modal: bool,
        toolbar: Option<ToolbarState>,
        /// The `+` of the screen, or none for a screen without one.
        plus: Option<PlusState>,
        /// What the iPad sidebar shows, or none outside the shell.
        sidebar: Option<SidebarState>,
        /// Where the history can move, while the window has a sidebar. The shell
        /// then shows a back and a forward button in place of the back button.
        history: Option<HistoryState>,
        theme: ChromeTheme,
    },
    /// A web push or pop slide starts or ends.
    Transition { phase: TransitionPhase },
    /// A user back swipe starts to move the page, or settles back without a
    /// pop.
    BackSwipe { phase: BackSwipePhase },
    /// The page listens for intents.
    ChromeReady,
}

/// The phase of a web push or pop slide.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TransitionPhase {
    Start,
    End,
}

/// The phase of a user back swipe.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BackSwipePhase {
    Start,
    Cancel,
}

/// Whether the page shows its shell, or a full-screen page with no bars
/// (onboarding, loading, the crash card).
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ChromeKind {
    Shell,
    None,
}

/// The theme preference of the page.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ChromeTheme {
    System,
    Light,
    Dark,
}

/// A tab of the shell.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ChromeTab {
    Daily,
    All,
    Tasks,
}

/// Whether the history can move back and forward.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct HistoryState {
    pub back: bool,
    pub forward: bool,
}

/// What the iPad sidebar shows.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SidebarState {
    /// The row to select: a tab, `chat`, or a pinned note's path after
    /// `pinned:`.
    pub selection: String,
    /// The pinned notes, in shelf order.
    pub pinned: Vec<PinnedNote>,
    pub graph_name: String,
    /// The graph's color as `#rrggbb`, or none for the app's tint.
    pub graph_color: Option<String>,
    /// The menu of the graph button.
    pub graph_menu: Vec<MenuItem>,
}

/// A pinned note in the iPad sidebar.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct PinnedNote {
    pub path: String,
    /// The name the sidebar shows.
    pub title: String,
}

/// The `+` of a screen: Daily's capture menu, or one action.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlusState {
    /// The capture menu. `audio` is the audio memo phase, or none where the
    /// recorder is unavailable: the menu then has no audio item.
    Capture { audio: Option<AudioPhase> },
    /// One action. `label` is the accessibility label.
    Action { label: String },
}

/// The phase of the audio memo recorder.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AudioPhase {
    Idle,
    Requesting,
    Recording,
    Transcribing,
    Error,
}

/// One row of a menu, or a section of rows, in the order the shell shows
/// them.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuItem {
    /// One row. specta-swift names its payload `MenuItemActionData`.
    Action {
        id: String,
        title: String,
        /// An SF Symbol name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destructive: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disabled: Option<bool>,
        /// Shows a checkmark.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirm: Option<MenuConfirm>,
    },
    Section {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        items: Vec<MenuItem>,
    },
}

/// A confirmation the shell shows before it sends the item's intent: an
/// action sheet (a popover on iPad) with one destructive button and Cancel.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct MenuConfirm {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The label of the destructive button.
    pub action: String,
}

/// A native button that floats in a top corner of the page. A tap opens
/// `menu` when it has one, and sends an `action` intent with `id` otherwise.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct BarButton {
    pub id: String,
    /// The label, also the accessibility label of an icon button.
    pub title: String,
    /// An SF Symbol name; without it the button shows `title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu: Option<Vec<MenuItem>>,
}

/// The formatting toolbar of the focused editor.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolbarState {
    pub can_indent: bool,
    pub can_dedent: bool,
    pub can_move_up: bool,
    pub can_move_down: bool,
    pub can_attach_files: bool,
}

/// What the shell sends the page: a tap on a native control, or a change of
/// the shell's layout.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChromeIntent {
    Back {
        entry_id: isize,
    },
    /// A move in the history, from the screen of `entry_id`.
    History {
        entry_id: isize,
        direction: HistoryDirection,
    },
    Tab {
        tab: ChromeTab,
    },
    Action {
        entry_id: isize,
        id: String,
    },
    Command {
        id: FormattingCommand,
    },
    Files {
        files: Vec<IntentFile>,
    },
    /// Whether the corner buttons sit in the page's header row, or in the row
    /// of the floating tab bar above it.
    Layout {
        corners_in_header_row: bool,
    },
    /// A tap on the `+` of the screen of `entry_id`.
    Plus {
        entry_id: isize,
        command: PlusCommand,
    },
    /// Whether the iPad sidebar shows, or none without a sidebar.
    SidebarVisible {
        visible: Option<bool>,
    },
    /// A tap in the iPad sidebar.
    Sidebar {
        command: SidebarIntent,
    },
}

/// The direction of a move in the history.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryDirection {
    Back,
    Forward,
}

/// A command of the page's formatting toolbar.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FormattingCommand {
    Slash,
    List,
    Todo,
    Link,
    Tag,
    Dedent,
    Indent,
    Up,
    Down,
    Dismiss,
}

/// A file the user picked, for the editor to attach.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct IntentFile {
    pub name: String,
    /// The MIME type.
    #[serde(rename = "type")]
    pub mime: String,
    /// The bytes, base64.
    pub data: String,
}

/// A tap on the `+` (`tap`) or on one item of the capture menu.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PlusCommand {
    Tap,
    Note,
    Task,
    Audio,
}

/// A tap in the iPad sidebar.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SidebarIntent {
    Chat,
    Search,
    Settings,
    /// Opens a pinned note.
    OpenNote {
        path: String,
    },
    Unpin {
        path: String,
    },
    Share {
        path: String,
    },
    /// An item of the graph menu.
    Menu {
        id: String,
    },
}
