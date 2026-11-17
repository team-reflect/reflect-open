//! `reflect-wasm-bindgen <input.wasm> <out-dir>` does what
//! `wasm-bindgen <input.wasm> --target web --no-typescript --out-dir <out-dir>` does.

use std::env;
use std::error::Error;

use wasm_bindgen_cli_support::Bindgen;

fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let [_, input, out_dir] = <[_; 3]>::try_from(env::args_os().collect::<Vec<_>>())
        .map_err(|_| "usage: reflect-wasm-bindgen <input.wasm> <out-dir>")?;
    Bindgen::new()
        .input_path(input)
        .web(true)?
        .omit_default_module_path(false)
        .generate(out_dir)?;
    Ok(())
}
