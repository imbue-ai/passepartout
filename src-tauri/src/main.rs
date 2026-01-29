// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod opencode;

use opencode::{OpencodeManager, StatusUpdate};
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            opencode: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<AppState>().inner().clone();

            // Initialize OpenCode in a background task
            tauri::async_runtime::spawn(async move {
                match OpencodeManager::new(&app_handle).await {
                    Ok(manager) => {
                        let mut opencode_guard = state.opencode.lock().await;
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
        .invoke_handler(tauri::generate_handler![send_message])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
