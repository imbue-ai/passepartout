use keyring::Entry;

/// Service name used for storing credentials in the system keychain
const SERVICE_NAME: &str = "passepartout";

/// Target name for keyring entries (helps with macOS keychain identification)
const TARGET_NAME: &str = "passepartout-api-keys";

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

/// Credential manager for storing and retrieving API keys from the system keychain
pub struct CredentialManager;

impl CredentialManager {
    /// Create an entry for a provider
    fn create_entry(provider: Provider) -> Result<Entry, String> {
        // Use new_with_target for better cross-platform compatibility
        // Target helps identify the entry in the keychain
        Entry::new_with_target(TARGET_NAME, SERVICE_NAME, provider.as_str())
            .map_err(|e| format!("Failed to create keyring entry: {}", e))
    }

    /// Save a credential for a provider to the system keychain
    pub fn save_credential(provider: Provider, api_key: &str) -> Result<(), String> {
        let entry = Self::create_entry(provider)?;
        println!(
            "[credentials] Setting password for entry: target={}, service={}, user={}",
            TARGET_NAME, SERVICE_NAME, provider.as_str()
        );

        entry
            .set_password(api_key)
            .map_err(|e| format!("Failed to save credential: {}", e))?;

        // Verify the save worked by reading it back
        match entry.get_password() {
            Ok(stored) => {
                if stored == api_key {
                    println!("[credentials] Verified: password was stored correctly");
                    Ok(())
                } else {
                    Err("Password verification failed: stored value doesn't match".to_string())
                }
            }
            Err(e) => Err(format!(
                "Password verification failed: could not read back: {}",
                e
            )),
        }
    }

    /// Get a credential for a provider from the system keychain
    pub fn get_credential(provider: Provider) -> Result<Option<String>, String> {
        let entry = Self::create_entry(provider)?;

        match entry.get_password() {
            Ok(password) => {
                println!(
                    "[credentials] Retrieved password for {}: {} chars",
                    provider.as_str(),
                    password.len()
                );
                Ok(Some(password))
            }
            Err(keyring::Error::NoEntry) => {
                println!("[credentials] No entry found for {}", provider.as_str());
                Ok(None)
            }
            Err(e) => {
                println!(
                    "[credentials] Error retrieving {}: {}",
                    provider.as_str(),
                    e
                );
                Err(format!("Failed to retrieve credential: {}", e))
            }
        }
    }

    /// Delete a credential for a provider from the system keychain
    pub fn delete_credential(provider: Provider) -> Result<(), String> {
        let entry = Self::create_entry(provider)?;

        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // Already deleted, that's fine
            Err(e) => Err(format!("Failed to delete credential: {}", e)),
        }
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
