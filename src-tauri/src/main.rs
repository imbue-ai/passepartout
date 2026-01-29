// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;
mod opencode;

use credentials::{CredentialManager, Provider};
use opencode::OpencodeManager;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

// State wrapper for the OpenCode manager
struct AppState {
    opencode: Arc<Mutex<Option<OpencodeManager>>>,
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
    let provider = Provider::from_str(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {}", provider_id))?;
    CredentialManager::save_credential(provider, &api_key)
}

/// Delete an API key for a provider from the system keychain
#[tauri::command]
fn delete_credential(provider_id: String) -> Result<(), String> {
    let provider = Provider::from_str(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {}", provider_id))?;
    CredentialManager::delete_credential(provider)
}

/// Get the status of all credentials (which providers have keys stored)
#[tauri::command]
fn list_credentials() -> Result<Vec<CredentialStatus>, String> {
    let credentials = CredentialManager::list_credentials()?;
    Ok(credentials
        .into_iter()
        .map(|(provider_id, has_key)| CredentialStatus {
            provider_id,
            has_key,
        })
        .collect())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            opencode: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let opencode_arc = app.state::<AppState>().opencode.clone();

            // Initialize OpenCode in a background task
            tauri::async_runtime::spawn(async move {
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
            list_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
