// Nexus desktop control center: a thin native window around the Core Service's UI.
// The service does all the work; closing this window never stops applications.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewWindowBuilder, WindowEvent};

const SERVICE_ID: &str = "NexusServer";

fn port() -> u16 {
    std::env::var("NEXUS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7780)
}

fn nexus_home() -> PathBuf {
    if let Ok(h) = std::env::var("NEXUS_HOME") {
        return PathBuf::from(h);
    }
    let data = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    PathBuf::from(data).join("Nexus")
}

/// Minimal loopback health check (no HTTP client dependency, never leaves this computer).
fn service_healthy(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut s) = TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(800)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET /api/v1/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200")
}

/// Asks Windows to start the Nexus service (it normally starts with Windows).
fn start_service() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("sc.exe").args(["start", SERVICE_ID]).creation_flags(CREATE_NO_WINDOW).output();
    }
    #[cfg(not(windows))]
    let _ = Command::new("true").output();
}

/// Called by the loader page: make sure the service is up, then return a signed-in address.
#[tauri::command]
async fn connect() -> Result<String, String> {
    let port = port();
    tauri::async_runtime::spawn_blocking(move || {
        if !service_healthy(port) {
            start_service();
            let deadline = Instant::now() + Duration::from_secs(60);
            while !service_healthy(port) {
                if Instant::now() > deadline {
                    return Err("The Nexus background service didn't respond. It may still be starting after a Windows update — wait a minute and press Try Again. If it keeps happening, reinstall Nexus.".to_string());
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        // The service rotates this token on every start and only administrators and the
        // installing user can read it. It signs the Owner in on this computer only.
        let token_file = nexus_home().join("local-access.token");
        let token = std::fs::read_to_string(&token_file)
            .map_err(|_| "Nexus is running, but this Windows account isn't allowed to open it. Sign in with the account that installed Nexus, or use a Nexus username and password.".to_string())?;
        let token = token.trim();
        if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("The local sign-in key is unreadable. Restart the Nexus service and try again.".to_string());
        }
        Ok(format!("http://127.0.0.1:{port}/?local={token}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pages that belong in this window: the bundled loader and the control center on this computer.
fn is_nexus_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("127.0.0.1") | Some("localhost") => url.port_or_known_default() == Some(port()),
            _ => false,
        },
        _ => false,
    }
}

/// Opens a web address in the person's default browser (only http/https; never a program or file).
fn open_in_browser(url: &Url) {
    if url.scheme() != "http" && url.scheme() != "https" {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url.as_str()]).creation_flags(CREATE_NO_WINDOW).spawn();
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // A second launch (Start menu, desktop icon) focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .invoke_handler(tauri::generate_handler![connect])
        .setup(|app| {
            // Links to applications and websites open in the normal browser: the webview would
            // otherwise silently ignore "open in a new window" links and could be navigated away.
            let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window config");
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(|url, _features| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .on_navigation(|url| {
                    if is_nexus_page(url) {
                        true
                    } else {
                        open_in_browser(url);
                        false
                    }
                })
                .build()?;
            let open = MenuItem::with_id(app, "open", "Open Nexus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Close control center", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("nexus")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Nexus Server — your applications keep running in the background")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Closing the window hides it to the tray; the service and apps are unaffected either way.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start the Nexus control center");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_nexus_pages_and_sends_everything_else_to_the_browser() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_nexus_page(&u("tauri://localhost/index.html")));
        assert!(is_nexus_page(&u("http://tauri.localhost/index.html")));
        assert!(is_nexus_page(&u("http://127.0.0.1:7780/apps/projectone")));
        assert!(!is_nexus_page(&u("https://mohamedgad.com/")));
        assert!(!is_nexus_page(&u("http://projectone.nexus.localhost:43732/")));
        assert!(!is_nexus_page(&u("http://127.0.0.1:43732/")));
        assert!(!is_nexus_page(&u("file:///C:/Windows/System32/cmd.exe")));
    }
}
