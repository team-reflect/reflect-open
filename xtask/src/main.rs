//! Repository automation, run as `cargo xtask <command>`.
//!
//! - `index-wasm`: builds `reflect-index-wasm` for `wasm32-unknown-unknown` and
//!   writes its bindings to `packages/index-wasm/pkg`.

use std::env;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

use wasm_bindgen_cli_support::Bindgen;

type Result<T = ()> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

fn main() -> Result {
    let args: Vec<String> = env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["index-wasm"] => index_wasm(),
        _ => Err("usage: cargo xtask index-wasm".into()),
    }
}

fn index_wasm() -> Result {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("the xtask crate has no parent directory")?;
    let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .current_dir(root)
        .args(["build", "--package", "reflect-index-wasm"])
        .args([
            "--target",
            "wasm32-unknown-unknown",
            "--profile",
            "wasm",
            "--locked",
        ])
        .status()?;
    if !status.success() {
        return Err(format!("cargo build failed: {status}").into());
    }
    let target_dir =
        env::var_os("CARGO_TARGET_DIR").map_or_else(|| PathBuf::from("target"), PathBuf::from);
    let wasm = root
        .join(target_dir)
        .join("wasm32-unknown-unknown/wasm/reflect_index_wasm.wasm");
    // The same output as `wasm-bindgen <wasm> --target web --no-typescript --out-dir pkg`.
    Bindgen::new()
        .input_path(wasm)
        .web(true)?
        .omit_default_module_path(false)
        .generate(root.join("packages/index-wasm/pkg"))?;
    Ok(())
}
