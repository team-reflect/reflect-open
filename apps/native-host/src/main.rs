//! Binary entry point: wire stdin/stdout to the host loop. Stdout is the
//! native-messaging channel — nothing else may write to it; diagnostics go to
//! stderr (Chrome surfaces them in its extension logs).

use std::process::ExitCode;

use reflect_capture_host::spool::default_pointer_path;

fn main() -> ExitCode {
    let Some(pointer_path) = default_pointer_path() else {
        eprintln!("reflect-capture-host: no OS config directory");
        return ExitCode::FAILURE;
    };
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    match reflect_capture_host::run(&mut stdin, &mut stdout, &pointer_path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reflect-capture-host: {error}");
            ExitCode::FAILURE
        }
    }
}
