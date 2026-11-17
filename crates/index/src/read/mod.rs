//! The read queries of the index: plain functions over a [`Connection`].
//! [`IndexSession::read`] runs each command's queries in one read
//! transaction.
//!
//! [`Connection`]: rusqlite::Connection
//! [`IndexSession::read`]: crate::IndexSession::read

pub(crate) mod chat;
pub(crate) mod daily;
pub(crate) mod meta;
pub(crate) mod stats;
