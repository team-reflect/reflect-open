//! iCloud Drive commands, forwarded to [`reflect_core::Core`].

// Public modules, not re-exported functions: `generate_handler!` resolves a
// command's hidden `__cmd__` companion macro at the same path as the
// function, which a `pub use` does not carry.
pub mod storage;
pub mod sweep;
pub mod watch;
