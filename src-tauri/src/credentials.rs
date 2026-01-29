use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Get the path to the credentials file
fn get_credentials_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set")?;
    Ok(PathBuf::from(home).join(".passepartout.json"))
}

/// Credentials stored in the JSON file
#[derive(Debug, Default, Serialize, Deserialize)]
struct CredentialsFile {
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

/// Supported LLM providers
#[derive(Debug, Clone, Copy)]
pub enum Provider {
    Anthropic,
    OpenAI,
    Google,
}

impl Provider {
    /// Get the provider ID as a string
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAI => "openai",
            Provider::Google => "google",
        }
    }

    /// Get the environment variable name for this provider's API key
    pub fn env_var_name(&self) -> &'static str {
        match self {
            Provider::Anthropic => "ANTHROPIC_API_KEY",
            Provider::OpenAI => "OPENAI_API_KEY",
            Provider::Google => "GOOGLE_API_KEY",
        }
    }

    /// Parse a provider from a string
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "anthropic" => Some(Provider::Anthropic),
            "openai" => Some(Provider::OpenAI),
            "google" => Some(Provider::Google),
            _ => None,
        }
    }

    /// Get all supported providers
    pub fn all() -> &'static [Provider] {
        &[Provider::Anthropic, Provider::OpenAI, Provider::Google]
    }
}

/// Credential manager for storing and retrieving API keys from a local JSON file
pub struct CredentialManager;

impl CredentialManager {
    /// Load credentials from the JSON file
    fn load_credentials() -> Result<CredentialsFile, String> {
        let path = get_credentials_path()?;
        if !path.exists() {
            return Ok(CredentialsFile::default());
        }
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read credentials file: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse credentials file: {}", e))
    }

    /// Save credentials to the JSON file with restricted permissions
    fn save_credentials(creds: &CredentialsFile) -> Result<(), String> {
        let path = get_credentials_path()?;
        let content = serde_json::to_string_pretty(creds)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

        // Write to a temp file first, then rename for atomicity
        let temp_path = path.with_extension("json.tmp");

        let mut file = fs::File::create(&temp_path)
            .map_err(|e| format!("Failed to create credentials file: {}", e))?;

        // Set permissions to 600 (owner read/write only) before writing content
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(0o600);
            fs::set_permissions(&temp_path, permissions)
                .map_err(|e| format!("Failed to set file permissions: {}", e))?;
        }

        file.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write credentials file: {}", e))?;

        // Rename temp file to actual file
        fs::rename(&temp_path, &path)
            .map_err(|e| format!("Failed to save credentials file: {}", e))?;

        println!("[credentials] Saved credentials to {:?}", path);
        Ok(())
    }

    /// Save a credential for a provider
    pub fn save_credential(provider: Provider, api_key: &str) -> Result<(), String> {
        let mut creds = Self::load_credentials()?;
        creds
            .api_keys
            .insert(provider.as_str().to_string(), api_key.to_string());
        Self::save_credentials(&creds)?;
        println!(
            "[credentials] Saved API key for {} ({} chars)",
            provider.as_str(),
            api_key.len()
        );
        Ok(())
    }

    /// Get a credential for a provider
    pub fn get_credential(provider: Provider) -> Result<Option<String>, String> {
        let creds = Self::load_credentials()?;
        let result = creds.api_keys.get(provider.as_str()).cloned();
        println!(
            "[credentials] Get credential for {}: {}",
            provider.as_str(),
            if result.is_some() { "found" } else { "not found" }
        );
        Ok(result)
    }

    /// Delete a credential for a provider
    pub fn delete_credential(provider: Provider) -> Result<(), String> {
        let mut creds = Self::load_credentials()?;
        creds.api_keys.remove(provider.as_str());
        Self::save_credentials(&creds)?;
        println!("[credentials] Deleted API key for {}", provider.as_str());
        Ok(())
    }

    /// Check if a credential exists for a provider
    pub fn has_credential(provider: Provider) -> Result<bool, String> {
        Ok(Self::get_credential(provider)?.is_some())
    }

    /// Get all credentials as a list of (provider_id, has_key) pairs
    pub fn list_credentials() -> Result<Vec<(String, bool)>, String> {
        let mut result = Vec::new();
        for provider in Provider::all() {
            let has_key = Self::has_credential(*provider)?;
            result.push((provider.as_str().to_string(), has_key));
        }
        Ok(result)
    }

    /// Get all credentials as environment variables for process spawning
    /// Returns a Vec of (env_var_name, api_key) pairs
    pub fn get_credentials_as_env_vars() -> Result<Vec<(String, String)>, String> {
        let mut env_vars = Vec::new();
        for provider in Provider::all() {
            if let Some(api_key) = Self::get_credential(*provider)? {
                env_vars.push((provider.env_var_name().to_string(), api_key));
            }
        }
        Ok(env_vars)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_as_str() {
        assert_eq!(Provider::Anthropic.as_str(), "anthropic");
        assert_eq!(Provider::OpenAI.as_str(), "openai");
        assert_eq!(Provider::Google.as_str(), "google");
    }

    #[test]
    fn test_provider_env_var_name() {
        assert_eq!(Provider::Anthropic.env_var_name(), "ANTHROPIC_API_KEY");
        assert_eq!(Provider::OpenAI.env_var_name(), "OPENAI_API_KEY");
        assert_eq!(Provider::Google.env_var_name(), "GOOGLE_API_KEY");
    }

    #[test]
    fn test_provider_from_str() {
        assert!(matches!(Provider::from_str("anthropic"), Some(Provider::Anthropic)));
        assert!(matches!(Provider::from_str("OPENAI"), Some(Provider::OpenAI)));
        assert!(matches!(Provider::from_str("Google"), Some(Provider::Google)));
        assert!(Provider::from_str("unknown").is_none());
    }
}
