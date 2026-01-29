use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatusUpdateDetails {
    #[serde(rename = "fullMessage", skip_serializing_if = "Option::is_none")]
    pub full_message: Option<String>,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default)]
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

/// JSON output from `opencode run --format json`
#[derive(Debug, Deserialize)]
struct OpencodeEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    part: Option<EventPart>,
}

#[derive(Debug, Deserialize)]
struct EventPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    state: Option<ToolState>,
    #[serde(default)]
    reason: Option<String>,
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

pub struct OpencodeManager {
    session_id: Arc<Mutex<Option<String>>>,
    workspace_path: String,
    native_tools_path: PathBuf,
    opencode_binary: PathBuf,
}

impl OpencodeManager {
    pub async fn new(app: &AppHandle) -> Result<Self, String> {
        use tauri::Manager;

        // Set up paths - use bundled resources in production, project paths in development
        let resource_path = app.path().resource_dir().map_err(|e| e.to_string())?;
        let native_tools_path = resource_path.join("native_tools");
        let opencode_workspace_path = resource_path.join("opencode_workspace");

        let (native_tools_path, opencode_workspace_path) = if native_tools_path.exists() {
            (native_tools_path, opencode_workspace_path)
        } else {
            let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_path_buf();
            (
                project_root.join("native_tools"),
                project_root.join("opencode_workspace"),
            )
        };

        // Find the opencode binary
        let opencode_binary = native_tools_path.join("opencode");
        let opencode_binary = if opencode_binary.exists() {
            opencode_binary
        } else {
            PathBuf::from("opencode")
        };

        let workspace_path = opencode_workspace_path.to_string_lossy().to_string();

        Ok(Self {
            session_id: Arc::new(Mutex::new(None)),
            workspace_path,
            native_tools_path,
            opencode_binary,
        })
    }

    pub async fn send_message<F>(
        &self,
        message: &str,
        _provider_id: &str,
        model_id: &str,
        status_callback: F,
    ) -> Result<String, String>
    where
        F: Fn(StatusUpdate) + Send + 'static,
    {
        // Build the command
        let mut cmd = Command::new(&self.opencode_binary);
        cmd.arg("run")
            .arg("-m")
            .arg(model_id)
            .arg("--format")
            .arg("json");

        // Add session ID if we have one from a previous message
        {
            let session_guard = self.session_id.lock().unwrap();
            if let Some(ref sid) = *session_guard {
                cmd.arg("--session").arg(sid);
            }
        }

        // Add the message
        cmd.arg(message);

        // Set up environment
        let mut path_env = env::var("PATH").unwrap_or_default();
        if self.native_tools_path.exists() {
            path_env = format!("{}:{}", self.native_tools_path.display(), path_env);
        }

        cmd.env("PATH", &path_env)
            .env(
                "PLAYWRIGHT_BROWSERS_PATH",
                self.native_tools_path.join("playwright_browsers"),
            )
            .current_dir(&self.workspace_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Spawn the process
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn opencode: {}", e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout".to_string())?;

        // Read and process output line by line
        let reader = BufReader::new(stdout);
        let mut response_text = String::new();
        let session_id_clone = self.session_id.clone();

        for line in reader.lines() {
            let line = line.map_err(|e| format!("Failed to read line: {}", e))?;
            if line.is_empty() {
                continue;
            }

            // Parse the JSON event
            let event: OpencodeEvent = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue, // Skip malformed lines
            };

            // Capture session ID from first event
            if let Some(ref sid) = event.session_id {
                let mut session_guard = session_id_clone.lock().unwrap();
                if session_guard.is_none() {
                    *session_guard = Some(sid.clone());
                }
            }

            // Process the event and send status updates
            if let Some(status) = Self::process_event(&event) {
                status_callback(status);
            }

            // Extract text from text events
            if event.event_type == "text" {
                if let Some(ref part) = event.part {
                    if part.part_type == "text" {
                        if let Some(ref text) = part.text {
                            response_text = text.clone();
                        }
                    }
                }
            }
        }

        // Wait for the process to finish
        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for opencode: {}", e))?;

        if !status.success() {
            return Err(format!("opencode exited with status: {}", status));
        }

        if response_text.is_empty() {
            Ok("No response received.".to_string())
        } else {
            Ok(response_text)
        }
    }

    fn process_event(event: &OpencodeEvent) -> Option<StatusUpdate> {
        match event.event_type.as_str() {
            "step_start" => Some(StatusUpdate {
                update_type: "busy".to_string(),
                message: Some("Thinking...".to_string()),
                details: Some(StatusUpdateDetails {
                    timestamp: Self::now_millis(),
                    ..Default::default()
                }),
            }),
            "step_finish" => {
                let reason = event
                    .part
                    .as_ref()
                    .and_then(|p| p.reason.clone())
                    .unwrap_or_default();
                Some(StatusUpdate {
                    update_type: "idle".to_string(),
                    message: Some(format!("Finished ({})", reason)),
                    details: Some(StatusUpdateDetails {
                        timestamp: Self::now_millis(),
                        ..Default::default()
                    }),
                })
            }
            "text" => Some(StatusUpdate {
                update_type: "generating".to_string(),
                message: Some("Generating response...".to_string()),
                details: Some(StatusUpdateDetails {
                    timestamp: Self::now_millis(),
                    ..Default::default()
                }),
            }),
            "tool_start" => {
                let part = event.part.as_ref()?;
                let tool_name = part.tool.as_ref()?;
                let state = part.state.as_ref();
                let title = state.and_then(|s| s.title.as_deref());
                let description = Self::get_tool_description(tool_name, title);
                let input = state.and_then(|s| s.input.clone());
                let input_short = Self::format_tool_input_for_status(tool_name, &input);
                let input_full = Self::format_tool_input_for_log(tool_name, &input);

                let format_with_input = |desc: &str, input_str: &str| {
                    if input_str.is_empty() {
                        desc.to_string()
                    } else {
                        format!("{}: {}", desc, input_str)
                    }
                };

                Some(StatusUpdate {
                    update_type: "tool".to_string(),
                    message: Some(format_with_input(&description, &input_short)),
                    details: Some(StatusUpdateDetails {
                        full_message: Some(format_with_input(&description, &input_full)),
                        tool_name: Some(tool_name.clone()),
                        timestamp: Self::now_millis(),
                        input,
                        ..Default::default()
                    }),
                })
            }
            "tool_finish" => {
                let part = event.part.as_ref()?;
                let tool_name = part.tool.as_ref()?;
                let state = part.state.as_ref();
                let title = state.and_then(|s| s.title.as_deref());
                let description = Self::get_tool_description(tool_name, title);
                let error = state.and_then(|s| s.error.clone());
                let output = state.and_then(|s| s.output.clone());
                let duration = state
                    .and_then(|s| s.time.as_ref())
                    .and_then(|t| Some(t.end? - t.start?));

                let is_error = error.is_some();
                let (update_type, message) = if is_error {
                    (
                        "tool-error",
                        format!(
                            "Error: {}",
                            error.as_deref().unwrap_or("Unknown error")
                        ),
                    )
                } else {
                    ("tool-completed", format!("{} completed", description))
                };

                Some(StatusUpdate {
                    update_type: update_type.to_string(),
                    message: Some(message),
                    details: Some(StatusUpdateDetails {
                        tool_name: Some(tool_name.clone()),
                        timestamp: Self::now_millis(),
                        output: if is_error { None } else { output },
                        error: if is_error { error } else { None },
                        duration,
                        ..Default::default()
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

        match tool_name.to_lowercase().as_str() {
            "read" => "Reading file",
            "write" => "Writing file",
            "edit" => "Editing file",
            "bash" => "Running command",
            "glob" => "Searching files",
            "grep" => "Searching content",
            "list_directory" => "Listing directory",
            "web_search" => "Searching the web",
            "web_fetch" => "Fetching webpage",
            _ => return format!("Running {}", tool_name),
        }
        .to_string()
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
