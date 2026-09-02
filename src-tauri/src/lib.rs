mod applog;
mod launch;
mod paths;
mod aws;
mod cli;
mod commands;
mod config;
mod discovery;
mod error;
mod secrets;
mod state;

use tauri_plugin_log::{Target, TargetKind};

/// Entry point shared by `main.rs` and (later) mobile targets.
///
/// The `creds` dispatch has to happen *before* `tauri::Builder` is ever
/// touched: `credential_process` invokes this same binary from the AWS
/// CLI on every `aws` command, and spinning up the webview runtime on
/// that path would be both slow and would flash a dock icon / try to
/// open a window for what must be a silent, instant JSON-on-stdout call.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("creds") => {
            cli::run_creds(&args[2..]);
            return;
        }
        // Bare `sleipnir` in a terminal: hand off to a detached instance and
        // give the shell back. See launch.rs for why, and for the two
        // conditions that keep this from recursing or firing under
        // `tauri dev`.
        None => {
            if launch::relaunch_detached() {
                return;
            }
        }
        // Explicit opt-out, for watching the log on stdout.
        Some("--foreground") | Some("-f") => {}
        Some(other) => {
            eprintln!("sleipnir: unrecognised argument `{other}`\n\n{}", launch::USAGE);
            std::process::exit(2);
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            // The WKWebView layer is transparent (macOSPrivateApi) so the
            // native window backing shows through any strip the webview
            // hasn't painted yet during a live resize — force that backing
            // to theme-void so resize lag is dark-on-dark, never a white
            // flash.
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(tauri::window::Color(9, 11, 14, 255)));
            }
            // The backend owns the credential-rotation schedule (static
            // ~/.aws/credentials keys go stale hourly); the frontend only
            // triggers extra passes on user-visible events.
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(240)).await;
                    let _ = commands::refresh_engaged_credentials().await;
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: Some(paths::log_file_stem().into()) }),
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::list_orgs,
            commands::save_org,
            commands::delete_org,
            commands::sign_out_org,
            commands::login_org,
            commands::cancel_login,
            commands::refresh_session,
            commands::list_accounts,
            commands::save_account,
            commands::delete_account,
            commands::list_projects,
            commands::save_project,
            commands::delete_project,
            commands::restore_project,
            commands::purge_project,
            commands::list_deleted_projects,
            commands::discover_accounts,
            commands::discover_grouped,
            commands::import_accounts,
            commands::rename_account,
            commands::test_profile,
            commands::get_state,
            commands::set_pin,
            commands::engage,
            commands::disengage,
            commands::disengage_all,
            commands::attach_engaged_to_project,
            commands::refresh_engaged_credentials,
            commands::is_dev_build,
            commands::app_paths,
            commands::open_in_file_manager,
            commands::read_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
