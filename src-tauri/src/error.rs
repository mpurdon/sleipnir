use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("{0}")]
    Login(String),
    #[error("unknown org: {0}")]
    UnknownOrg(String),
    #[error("{0}")]
    Discovery(String),
    #[error("saving config: {0}")]
    Io(String),
    #[error("{0}")]
    Invalid(String),
}

impl From<crate::aws::sso_oidc::LoginError> for AppError {
    fn from(e: crate::aws::sso_oidc::LoginError) -> Self {
        AppError::Login(e.to_string())
    }
}

impl From<crate::config::RestoreError> for AppError {
    fn from(e: crate::config::RestoreError) -> Self {
        match e {
            crate::config::RestoreError::Io(io) => AppError::Io(io.to_string()),
            // A name clash is the user's to resolve, not a system failure —
            // Invalid carries the actionable message straight to the UI.
            other => AppError::Invalid(other.to_string()),
        }
    }
}

impl From<crate::aws::sso::DiscoveryError> for AppError {
    fn from(e: crate::aws::sso::DiscoveryError) -> Self {
        AppError::Discovery(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}
