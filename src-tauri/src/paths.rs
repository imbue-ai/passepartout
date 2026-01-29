use std::env;
use std::path::PathBuf;
use tauri::AppHandle;

/// Common paths used by the application
pub struct AppPaths {
    pub native_tools_path: PathBuf,
    pub opencode_workspace_path: PathBuf,
}

impl AppPaths {
    /// Resolve application paths from the Tauri app handle.
    /// Uses bundled resources in production, project paths in development.
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        use tauri::Manager;

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

        Ok(Self {
            native_tools_path,
            opencode_workspace_path,
        })
    }

    /// Get PATH environment variable with native_tools prepended
    pub fn get_path_env(&self) -> String {
        let mut path_env = env::var("PATH").unwrap_or_default();
        if self.native_tools_path.exists() {
            path_env = format!("{}:{}", self.native_tools_path.display(), path_env);
        }
        path_env
    }

    /// Get the path to a binary in native_tools, falling back to system PATH
    pub fn get_binary_path(&self, name: &str) -> PathBuf {
        let binary_path = self.native_tools_path.join(name);
        if binary_path.exists() {
            binary_path
        } else {
            PathBuf::from(name)
        }
    }

    /// Get the PLAYWRIGHT_BROWSERS_PATH environment variable value
    pub fn get_playwright_browsers_path(&self) -> PathBuf {
        self.native_tools_path.join("playwright_browsers")
    }
}
