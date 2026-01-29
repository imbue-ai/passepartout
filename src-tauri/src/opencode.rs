use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusUpdateDetails {
    #[serde(rename = "fullMessage", skip_serializing_if = "Option::is_none")]
    pub full_message: Option<String>,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusUpdate {
    #[serde(rename = "type")]
    pub update_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<StatusUpdateDetails>,
}

#[derive(Debug, Deserialize)]
struct SessionCreateResponse {
    id: String,
}

#[derive(Debug, Serialize)]
struct PromptPart {
    #[serde(rename = "type")]
    part_type: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct ModelConfig {
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(rename = "modelID")]
    model_id: String,
}

#[derive(Debug, Serialize)]
struct PromptRequest {
    parts: Vec<PromptPart>,
    model: ModelConfig,
}

#[derive(Debug, Deserialize)]
struct PromptResponsePart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PromptResponse {
    #[allow(dead_code)]
    info: Option<serde_json::Value>,
    parts: Option<Vec<PromptResponsePart>>,
}

#[derive(Debug, Deserialize)]
struct EventProperties {
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    status: Option<EventStatus>,
    part: Option<EventPart>,
}

#[derive(Debug, Deserialize)]
struct EventStatus {
    #[serde(rename = "type")]
    status_type: String,
    attempt: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct EventPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    tool: Option<String>,
    state: Option<ToolState>,
}

#[derive(Debug, Deserialize)]
struct ToolState {
    status: Option<String>,
    title: Option<String>,
    input: Option<serde_json::Value>,
    output: Option<String>,
    error: Option<String>,
    time: Option<ToolTime>,
}

#[derive(Debug, Deserialize)]
struct ToolTime {
    start: Option<u64>,
    end: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct Event {
    #[serde(rename = "type")]
    event_type: String,
    properties: Option<EventProperties>,
}

pub struct OpencodeManager {
    client: Client,
    base_url: String,
    auth_header: String,
    session_id: String,
    workspace_path: String,
    #[allow(dead_code)]
    server_process: Option<Child>,
}

impl OpencodeManager {
    pub async fn new(app: &AppHandle) -> Result<Self, String> {
        println!("[OpenCode] Starting initialization...");

        // Generate random credentials
        let username = "passepartout";
        let password: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(64)
            .map(char::from)
            .collect();

        // Find an available port
        let port = portpicker::pick_unused_port().ok_or("Could not find an available port")?;
        let base_url = format!("http://127.0.0.1:{}", port);
        println!("[OpenCode] Selected port: {}", port);

        // Set up paths
        let resource_path = app.path().resource_dir().map_err(|e| e.to_string())?;
        println!("[OpenCode] Resource path: {:?}", resource_path);
        let native_tools_path = resource_path.join("native_tools");
        let opencode_workspace_path = resource_path.join("opencode_workspace");

        // Check if we're in development mode (resource paths don't exist)
        let (native_tools_path, opencode_workspace_path) = if !native_tools_path.exists() {
            println!("[OpenCode] Development mode detected (resource paths don't exist)");
            // Development mode - use paths relative to the project
            let dev_native_tools = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("native_tools");
            let dev_workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("opencode_workspace");
            (dev_native_tools, dev_workspace)
        } else {
            println!("[OpenCode] Production mode (using bundled resources)");
            (native_tools_path, opencode_workspace_path)
        };

        println!("[OpenCode] Native tools path: {:?} (exists: {})", native_tools_path, native_tools_path.exists());
        println!("[OpenCode] Workspace path: {:?} (exists: {})", opencode_workspace_path, opencode_workspace_path.exists());

        // Set up environment for the OpenCode server
        let mut path_env = env::var("PATH").unwrap_or_default();
        if native_tools_path.exists() {
            path_env = format!("{}:{}", native_tools_path.display(), path_env);
        }

        // Find the opencode binary
        let opencode_binary = if native_tools_path.join("opencode").exists() {
            native_tools_path.join("opencode")
        } else {
            // Try to find it in PATH
            PathBuf::from("opencode")
        };
        println!("[OpenCode] Binary path: {:?} (exists: {})", opencode_binary, opencode_binary.exists());

        // Start the OpenCode server
        // Note: Don't set current_dir - the opencode binary has its own directory requirements.
        // The workspace directory is passed via X-Opencode-Directory header when creating sessions.
        println!("[OpenCode] Starting server with args: serve --port {}", port);
        let mut server_process = Command::new(&opencode_binary)
            .args(["serve", "--port", &port.to_string()])
            .env("PATH", &path_env)
            .env("OPENCODE_SERVER_USERNAME", &username)
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env(
                "PLAYWRIGHT_BROWSERS_PATH",
                native_tools_path.join("playwright_browsers"),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start OpenCode server: {}", e))?;

        println!("[OpenCode] Server process spawned with PID: {:?}", server_process.id());

        // Create HTTP client
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let auth_header = format!("Basic {}", BASE64.encode(format!("{}:{}", username, password)));

        // Wait for the server to be ready using health check
        let mut retries = 0;
        let max_retries = 60;
        loop {
            match client
                .get(format!("{}/global/health", base_url))
                .header("Authorization", &auth_header)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    println!("[OpenCode] Health check passed after {} retries", retries);
                    break;
                }
                Ok(resp) => {
                    println!("[OpenCode] Health check returned status: {}", resp.status());
                }
                Err(e) => {
                    if retries % 10 == 0 {
                        println!("[OpenCode] Health check attempt {}/{}: {}", retries, max_retries, e);
                    }
                }
            }

            retries += 1;
            if retries >= max_retries {
                return Err(format!("OpenCode server failed to start after {} retries", max_retries));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        println!("[OpenCode] Server started on {}", base_url);

        // Store the workspace path as a string for later use
        let workspace_path = opencode_workspace_path.to_string_lossy().to_string();
        println!("[OpenCode] Using workspace path: {}", workspace_path);

        // Create a session
        let session_resp = client
            .post(format!("{}/session", base_url))
            .header("Authorization", &auth_header)
            .header("Content-Type", "application/json")
            .header("X-Opencode-Directory", &workspace_path)
            .json(&serde_json::json!({ "title": "Chat Session" }))
            .send()
            .await
            .map_err(|e| format!("Failed to create session: {}", e))?;

        let session_status = session_resp.status();
        let session_body = session_resp
            .text()
            .await
            .map_err(|e| format!("Failed to read session response body: {}", e))?;

        println!("[OpenCode] Session create response ({}): {}", session_status, &session_body[..session_body.len().min(500)]);

        if !session_status.is_success() {
            return Err(format!("Failed to create session ({}): {}", session_status, session_body));
        }

        let session_response: SessionCreateResponse = serde_json::from_str(&session_body)
            .map_err(|e| format!("Failed to parse session response: {}. Body: {}", e, &session_body[..session_body.len().min(200)]))?;

        println!("OpenCode session created: {}", session_response.id);

        Ok(Self {
            client,
            base_url,
            auth_header,
            session_id: session_response.id,
            workspace_path,
            server_process: Some(server_process),
        })
    }

    pub async fn send_message<F>(
        &self,
        message: &str,
        provider_id: &str,
        model_id: &str,
        status_callback: F,
    ) -> Result<String, String>
    where
        F: Fn(StatusUpdate) + Send + 'static,
    {
        // Start event subscription in background
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        let auth_header = self.auth_header.clone();
        let session_id = self.session_id.clone();
        let session_id_for_events = session_id.clone();

        let event_handle = tokio::spawn(async move {
            Self::subscribe_to_events(client, base_url, auth_header, session_id_for_events, status_callback).await;
        });

        // Send the prompt
        let request = PromptRequest {
            parts: vec![PromptPart {
                part_type: "text".to_string(),
                text: message.to_string(),
            }],
            model: ModelConfig {
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
            },
        };

        let response = self
            .client
            .post(format!("{}/session/{}/message", self.base_url, self.session_id))
            .header("Authorization", &self.auth_header)
            .header("Content-Type", "application/json")
            .header("X-Opencode-Directory", &self.workspace_path)
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Failed to send message: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("API error ({}): {}", status, body));
        }

        // Get the response body as text first for debugging
        let response_text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        println!("[OpenCode] Response body: {}", &response_text[..response_text.len().min(500)]);

        let prompt_response: PromptResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse response: {}. Body: {}", e, &response_text[..response_text.len().min(200)]))?;

        // Cancel the event subscription
        event_handle.abort();

        // Extract text parts from the response
        if let Some(parts) = prompt_response.parts {
            let text_parts: Vec<String> = parts
                .into_iter()
                .filter(|p| p.part_type == "text")
                .filter_map(|p| p.text)
                .collect();

            if text_parts.is_empty() {
                Ok("No response received.".to_string())
            } else {
                Ok(text_parts.join("\n"))
            }
        } else {
            Ok("No response received.".to_string())
        }
    }

    async fn subscribe_to_events<F>(
        client: Client,
        base_url: String,
        auth_header: String,
        session_id: String,
        status_callback: F,
    ) where
        F: Fn(StatusUpdate) + Send + 'static,
    {
        let response = match client
            .get(format!("{}/event", base_url))
            .header("Authorization", &auth_header)
            .header("Accept", "text/event-stream")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Failed to subscribe to events: {}", e);
                return;
            }
        };

        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;

        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    // Process complete SSE messages
                    while let Some(pos) = buffer.find("\n\n") {
                        let message = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        // Parse SSE message
                        if let Some(data) = message.strip_prefix("data: ") {
                            if let Ok(event) = serde_json::from_str::<Event>(data) {
                                if let Some(status) =
                                    Self::process_event(&event, &session_id)
                                {
                                    status_callback(status);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Event stream error: {}", e);
                    break;
                }
            }
        }
    }

    fn process_event(event: &Event, session_id: &str) -> Option<StatusUpdate> {
        let props = event.properties.as_ref()?;

        match event.event_type.as_str() {
            "session.status" => {
                let event_session_id = props.session_id.as_ref()?;
                if event_session_id != session_id {
                    return None;
                }

                let status = props.status.as_ref()?;
                match status.status_type.as_str() {
                    "busy" => Some(StatusUpdate {
                        update_type: "busy".to_string(),
                        message: Some("Thinking...".to_string()),
                        details: Some(StatusUpdateDetails {
                            full_message: None,
                            tool_name: None,
                            timestamp: Self::now_millis(),
                            input: None,
                            output: None,
                            error: None,
                            duration: None,
                        }),
                    }),
                    "idle" => Some(StatusUpdate {
                        update_type: "idle".to_string(),
                        message: None,
                        details: Some(StatusUpdateDetails {
                            full_message: None,
                            tool_name: None,
                            timestamp: Self::now_millis(),
                            input: None,
                            output: None,
                            error: None,
                            duration: None,
                        }),
                    }),
                    "retry" => Some(StatusUpdate {
                        update_type: "retry".to_string(),
                        message: Some(format!(
                            "Retrying (attempt {})...",
                            status.attempt.unwrap_or(1)
                        )),
                        details: Some(StatusUpdateDetails {
                            full_message: None,
                            tool_name: None,
                            timestamp: Self::now_millis(),
                            input: None,
                            output: None,
                            error: None,
                            duration: None,
                        }),
                    }),
                    _ => None,
                }
            }
            "message.part.updated" => {
                let part = props.part.as_ref()?;
                let part_session_id = part.session_id.as_ref()?;
                if part_session_id != session_id {
                    return None;
                }

                match part.part_type.as_str() {
                    "tool" => {
                        let tool_name = part.tool.as_ref()?;
                        let state = part.state.as_ref()?;
                        let status_str = state.status.as_ref()?;

                        match status_str.as_str() {
                            "running" => {
                                let description =
                                    Self::get_tool_description(tool_name, state.title.as_deref());
                                let input_summary_truncated =
                                    Self::format_tool_input_for_status(tool_name, &state.input);
                                let input_summary_full =
                                    Self::format_tool_input_for_log(tool_name, &state.input);

                                let message = if input_summary_truncated.is_empty() {
                                    description.clone()
                                } else {
                                    format!("{}: {}", description, input_summary_truncated)
                                };

                                let full_message = if input_summary_full.is_empty() {
                                    description
                                } else {
                                    format!("{}: {}", description, input_summary_full)
                                };

                                Some(StatusUpdate {
                                    update_type: "tool".to_string(),
                                    message: Some(message),
                                    details: Some(StatusUpdateDetails {
                                        full_message: Some(full_message),
                                        tool_name: Some(tool_name.clone()),
                                        timestamp: Self::now_millis(),
                                        input: state.input.clone(),
                                        output: None,
                                        error: None,
                                        duration: None,
                                    }),
                                })
                            }
                            "completed" => {
                                let duration = state
                                    .time
                                    .as_ref()
                                    .and_then(|t| Some(t.end? - t.start?));
                                let description =
                                    Self::get_tool_description(tool_name, state.title.as_deref());

                                Some(StatusUpdate {
                                    update_type: "tool-completed".to_string(),
                                    message: Some(format!("{} completed", description)),
                                    details: Some(StatusUpdateDetails {
                                        full_message: None,
                                        tool_name: Some(tool_name.clone()),
                                        timestamp: Self::now_millis(),
                                        input: None,
                                        output: state.output.clone(),
                                        error: None,
                                        duration,
                                    }),
                                })
                            }
                            "error" => {
                                let duration = state
                                    .time
                                    .as_ref()
                                    .and_then(|t| Some(t.end? - t.start?));

                                Some(StatusUpdate {
                                    update_type: "tool-error".to_string(),
                                    message: Some(format!(
                                        "Error: {}",
                                        state.error.as_deref().unwrap_or("Unknown error")
                                    )),
                                    details: Some(StatusUpdateDetails {
                                        full_message: None,
                                        tool_name: Some(tool_name.clone()),
                                        timestamp: Self::now_millis(),
                                        input: None,
                                        output: None,
                                        error: state.error.clone(),
                                        duration,
                                    }),
                                })
                            }
                            _ => None,
                        }
                    }
                    "reasoning" => Some(StatusUpdate {
                        update_type: "reasoning".to_string(),
                        message: Some("Reasoning...".to_string()),
                        details: Some(StatusUpdateDetails {
                            full_message: None,
                            tool_name: None,
                            timestamp: Self::now_millis(),
                            input: None,
                            output: None,
                            error: None,
                            duration: None,
                        }),
                    }),
                    "text" => Some(StatusUpdate {
                        update_type: "generating".to_string(),
                        message: Some("Generating response...".to_string()),
                        details: Some(StatusUpdateDetails {
                            full_message: None,
                            tool_name: None,
                            timestamp: Self::now_millis(),
                            input: None,
                            output: None,
                            error: None,
                            duration: None,
                        }),
                    }),
                    _ => None,
                }
            }
            "session.idle" => {
                let event_session_id = props.session_id.as_ref()?;
                if event_session_id != session_id {
                    return None;
                }

                Some(StatusUpdate {
                    update_type: "idle".to_string(),
                    message: None,
                    details: Some(StatusUpdateDetails {
                        full_message: None,
                        tool_name: None,
                        timestamp: Self::now_millis(),
                        input: None,
                        output: None,
                        error: None,
                        duration: None,
                    }),
                })
            }
            _ => None,
        }
    }

    fn now_millis() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn get_tool_description(tool_name: &str, title: Option<&str>) -> String {
        if let Some(t) = title {
            return t.to_string();
        }

        let descriptions: HashMap<&str, &str> = [
            ("read", "Reading file"),
            ("write", "Writing file"),
            ("edit", "Editing file"),
            ("bash", "Running command"),
            ("glob", "Searching files"),
            ("grep", "Searching content"),
            ("list_directory", "Listing directory"),
            ("web_search", "Searching the web"),
            ("web_fetch", "Fetching webpage"),
        ]
        .into_iter()
        .collect();

        descriptions
            .get(tool_name.to_lowercase().as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Running {}", tool_name))
    }

    fn truncate_for_status(text: &str, max_length: usize) -> String {
        if text.len() <= max_length {
            text.to_string()
        } else {
            format!("{}...", &text[..max_length - 3])
        }
    }

    fn format_tool_input_for_status(tool_name: &str, input: &Option<serde_json::Value>) -> String {
        let input = match input {
            Some(v) => v,
            None => return String::new(),
        };

        let tool = tool_name.to_lowercase();

        match tool.as_str() {
            "read" | "write" | "edit" => {
                let file_path = input
                    .get("file_path")
                    .or_else(|| input.get("path"))
                    .or_else(|| input.get("filename"))
                    .and_then(|v| v.as_str());

                if let Some(path) = file_path {
                    path.rsplit('/').next().unwrap_or(path).to_string()
                } else {
                    String::new()
                }
            }
            "bash" => input
                .get("command")
                .and_then(|v| v.as_str())
                .map(|c| Self::truncate_for_status(c, 50))
                .unwrap_or_default(),
            "glob" => input
                .get("pattern")
                .and_then(|v| v.as_str())
                .map(|p| Self::truncate_for_status(p, 40))
                .unwrap_or_default(),
            "grep" => input
                .get("pattern")
                .and_then(|v| v.as_str())
                .map(|p| format!("\"{}\"", Self::truncate_for_status(p, 30)))
                .unwrap_or_default(),
            "web_search" => input
                .get("query")
                .and_then(|v| v.as_str())
                .map(|q| format!("\"{}\"", Self::truncate_for_status(q, 40)))
                .unwrap_or_default(),
            "web_fetch" => input
                .get("url")
                .and_then(|v| v.as_str())
                .map(|u| {
                    url::Url::parse(u)
                        .map(|parsed| parsed.host_str().unwrap_or(u).to_string())
                        .unwrap_or_else(|_| Self::truncate_for_status(u, 40))
                })
                .unwrap_or_default(),
            _ => String::new(),
        }
    }

    fn format_tool_input_for_log(tool_name: &str, input: &Option<serde_json::Value>) -> String {
        let input = match input {
            Some(v) => v,
            None => return String::new(),
        };

        let tool = tool_name.to_lowercase();

        match tool.as_str() {
            "read" | "write" | "edit" => input
                .get("file_path")
                .or_else(|| input.get("path"))
                .or_else(|| input.get("filename"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            "bash" => input
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            "glob" => input
                .get("pattern")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            "grep" => input
                .get("pattern")
                .and_then(|v| v.as_str())
                .map(|p| format!("\"{}\"", p))
                .unwrap_or_default(),
            "web_search" => input
                .get("query")
                .and_then(|v| v.as_str())
                .map(|q| format!("\"{}\"", q))
                .unwrap_or_default(),
            "web_fetch" => input
                .get("url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            _ => String::new(),
        }
    }
}

impl Drop for OpencodeManager {
    fn drop(&mut self) {
        if let Some(mut process) = self.server_process.take() {
            let _ = process.kill();
        }
    }
}
