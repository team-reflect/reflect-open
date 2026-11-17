//! The read queries of the index: plain functions over a [`Connection`].
//! [`IndexSession::read`] runs each command's queries in one read
//! transaction.
//!
//! [`Connection`]: rusqlite::Connection
//! [`IndexSession::read`]: crate::IndexSession::read

pub(crate) mod assets;
pub(crate) mod backlinks;
pub(crate) mod chat;
pub(crate) mod daily;
pub(crate) mod embed;
pub(crate) mod lists;
pub(crate) mod meta;
pub(crate) mod notes;
pub(crate) mod search;
pub(crate) mod stats;
pub(crate) mod suggest;
pub(crate) mod tasks;
pub(crate) mod wiki;
