//! Stand-in for platforms without llama.cpp. [`crate::supported`] is false
//! there, so the core never loads a model.

use std::path::Path;

/// A model that never loads.
pub struct Model {}

impl Model {
    pub fn load(_path: &Path) -> Result<Self, String> {
        Err(unsupported())
    }

    pub fn embed_query(&mut self, _text: &str) -> Result<Vec<f32>, String> {
        Err(unsupported())
    }

    pub fn embed_document(&mut self, _text: &str) -> Result<Vec<f32>, String> {
        Err(unsupported())
    }
}

fn unsupported() -> String {
    "the embedding runtime is not supported on this platform".into()
}
