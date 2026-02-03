// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;
mod fs_utils;
mod opencode;
mod paths;

use credentials::{CredentialManager, Provider};
use opencode::OpencodeManager;
use paths::AppPaths;
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

// State wrapper for the OpenCode manager and app paths
struct AppState {
    opencode: Arc<Mutex<Option<OpencodeManager>>>,
    paths: Arc<Mutex<Option<AppPaths>>>,
}

#[tauri::command]
async fn send_message(
    message: String,
    provider_id: String,
    model_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let opencode_guard = state.opencode.lock().await;
    let opencode = opencode_guard
        .as_ref()
        .ok_or_else(|| "OpenCode SDK not initialized. Please restart the app.".to_string())?;

    // Clone the app handle for status updates
    let app_clone = app.clone();

    opencode
        .send_message(&message, &provider_id, &model_id, move |status| {
            let _ = app_clone.emit("chat:statusUpdate", &status);
        })
        .await
}

/// Credential status for a single provider
#[derive(serde::Serialize)]
struct CredentialStatus {
    provider_id: String,
    has_key: bool,
}

/// Save an API key for a provider to the system keychain
#[tauri::command]
fn save_credential(provider_id: String, api_key: String) -> Result<(), String> {
    println!("[credentials] Saving credential for provider: {}", provider_id);
    let provider = Provider::from_str(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {}", provider_id))?;
    match CredentialManager::save_credential(provider, &api_key) {
        Ok(()) => {
            println!("[credentials] Successfully saved credential for: {}", provider_id);
            Ok(())
        }
        Err(e) => {
            eprintln!("[credentials] Failed to save credential for {}: {}", provider_id, e);
            Err(e)
        }
    }
}

/// Delete an API key for a provider from the system keychain
#[tauri::command]
fn delete_credential(provider_id: String) -> Result<(), String> {
    println!("[credentials] Deleting credential for provider: {}", provider_id);
    let provider = Provider::from_str(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {}", provider_id))?;
    match CredentialManager::delete_credential(provider) {
        Ok(()) => {
            println!("[credentials] Successfully deleted credential for: {}", provider_id);
            Ok(())
        }
        Err(e) => {
            eprintln!("[credentials] Failed to delete credential for {}: {}", provider_id, e);
            Err(e)
        }
    }
}

/// Get the status of all credentials (which providers have keys stored)
#[tauri::command]
fn list_credentials() -> Result<Vec<CredentialStatus>, String> {
    println!("[credentials] Listing all credentials");
    match CredentialManager::list_credentials() {
        Ok(credentials) => {
            println!("[credentials] Found {} providers", credentials.len());
            for (provider_id, has_key) in &credentials {
                println!("[credentials] - {}: has_key={}", provider_id, has_key);
            }
            Ok(credentials
                .into_iter()
                .map(|(provider_id, has_key)| CredentialStatus {
                    provider_id,
                    has_key,
                })
                .collect())
        }
        Err(e) => {
            eprintln!("[credentials] Failed to list credentials: {}", e);
            Err(e)
        }
    }
}

/// Result of running latchkey ensure-browser
#[derive(serde::Serialize)]
struct BrowserCheckResult {
    success: bool,
    output: String,
}

/// Run `latchkey ensure-browser` to ensure browser is available
#[tauri::command]
async fn ensure_browser(state: State<'_, AppState>) -> Result<BrowserCheckResult, String> {
    println!("[browser] Running latchkey ensure-browser...");

    let paths_guard = state.paths.lock().await;
    let paths = paths_guard
        .as_ref()
        .ok_or_else(|| "App paths not initialized".to_string())?;

    let latchkey_binary = paths.get_binary_path("latchkey");
    let path_env = paths.get_path_env();
    let playwright_browsers_path = paths.get_playwright_browsers_path();

    println!("[browser] Using latchkey binary: {:?}", latchkey_binary);
    println!("[browser] PATH: {}", path_env);

    let result = Command::new(&latchkey_binary)
        .arg("ensure-browser")
        .env("PATH", &path_env)
        .env("PLAYWRIGHT_BROWSERS_PATH", &playwright_browsers_path)
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let combined_output = if stderr.is_empty() {
                stdout
            } else if stdout.is_empty() {
                stderr
            } else {
                format!("{}\n{}", stdout, stderr)
            };

            let success = output.status.success();
            println!("[browser] Command completed with success={}, output: {}", success, combined_output);

            Ok(BrowserCheckResult {
                success,
                output: combined_output,
            })
        }
        Err(e) => {
            let error_msg = format!("Failed to run latchkey: {}", e);
            eprintln!("[browser] {}", error_msg);
            Ok(BrowserCheckResult {
                success: false,
                output: error_msg,
            })
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            opencode: Arc::new(Mutex::new(None)),
            paths: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<AppState>();
            let opencode_arc = state.opencode.clone();
            let paths_arc = state.paths.clone();

            // Initialize paths and OpenCode in a background task
            tauri::async_runtime::spawn(async move {
                // Initialize paths first
                match AppPaths::new(&app_handle) {
                    Ok(app_paths) => {
                        println!("App paths initialized: native_tools={:?}", app_paths.native_tools_path);
                        let mut paths_guard = paths_arc.lock().await;
                        *paths_guard = Some(app_paths);
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize app paths: {}", e);
                    }
                }

                // Initialize OpenCode manager
                match OpencodeManager::new(&app_handle).await {
                    Ok(manager) => {
                        let mut opencode_guard = opencode_arc.lock().await;
                        *opencode_guard = Some(manager);
                        println!("OpenCode manager initialized successfully");
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize OpenCode manager: {}", e);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            save_credential,
            delete_credential,
            list_credentials,
            ensure_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
