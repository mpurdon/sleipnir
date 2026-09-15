mod applog;
mod atomic_file;
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
            // ~/.aws/credentials keys go stale hourly); the frontend
            // triggers extra passes when the window is shown again.
            //
            // The tick is short because of how sleep interacts with the
            // timer. `tokio::time::sleep` is driven by `Instant`, and on
            // Apple platforms `Instant` is `CLOCK_UPTIME_RAW`, which does
            // NOT advance while the machine is asleep (see rust's
            // `library/std/src/sys/pal/unix/../../time/unix.rs`). A timer
            // armed before the lid closes therefore resumes mid-countdown
            // on wake — so with a long tick, someone who opens their
            // laptop in the morning gets minutes of awake time during
            // which `~/.aws/credentials` holds keys that died overnight,
            // and the first `aws` command of the day fails. Ticking every
            // 30s bounds that. A pass costs a state read plus one small
            // cache read per engaged profile and makes no network call
            // unless something is actually near expiry, so the extra
            // frequency is close to free.
            //
            // A macOS `NSWorkspace::didWakeNotification` hook would close
            // the remaining seconds, at the price of platform-specific
            // code the Windows packaging on the roadmap would have to
            // work around.
            tauri::async_runtime::spawn(async {
                const TICK: std::time::Duration = std::time::Duration::from_secs(30);
                let mut last_tick = std::time::SystemTime::now();
                loop {
                    tokio::time::sleep(TICK).await;
                    // SystemTime is the wall clock, so unlike the timer it
                    // *does* count time spent asleep. A gap much larger
                    // than the tick means the machine was suspended, which
                    // is worth a log line: it is the explanation for keys
                    // that were dead on arrival this morning.
                    let now = std::time::SystemTime::now();
                    let elapsed = now.duration_since(last_tick).unwrap_or(TICK);
                    last_tick = now;
                    if elapsed > TICK * 4 {
                        applog::info(
                            format!("resumed after {}s asleep — rotating credentials now", elapsed.as_secs()),
                            &serde_json::json!({"asleepSecs": elapsed.as_secs()}),
                        );
                    }
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
            commands::credential_health,
            commands::is_dev_build,
            commands::app_paths,
            commands::open_in_file_manager,
            commands::read_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
