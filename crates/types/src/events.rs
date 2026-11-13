//! Names of the events the native side broadcasts to the frontend.

/// Defines one `pub const` per event and [`ALL`], the list the codegen bin
/// writes to TypeScript and Swift.
macro_rules! events {
    ($( $(#[doc = $doc:literal])* $name:ident = $value:literal, )*) => {
        $( $(#[doc = $doc])* pub const $name: &str = $value; )*

        /// Every event: its constant name and its wire name.
        pub const ALL: &[(&str, &str)] = &[$( (stringify!($name), $value) ),*];
    };
}

events! {
    /// Batched [`crate::FileChange`]s for files that changed outside the editor.
    INDEX_CHANGED = "index:changed",
    /// Asks the frontend for one full reconcile pass. Carries no payload.
    INDEX_RECONCILE = "index:reconcile",
    /// Fired after a note-projection write commits. Secondary note windows run
    /// no indexer of their own and refetch their index-backed queries on this
    /// signal.
    INDEX_WRITTEN = "index:written",
    /// Fired after a note's rows move to a new path (an in-app rename or an
    /// id-healed external one), with `{ "from": ..., "to": ... }`.
    NOTE_MOVED = "note:moved",
}
