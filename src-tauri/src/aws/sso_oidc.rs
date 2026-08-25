//! AWS SSO OIDC device-authorization flow — the same flow `aws sso login`
//! uses: RegisterClient → StartDeviceAuthorization → open browser → poll
//! CreateToken. See the plan doc's §Backend architecture.

use crate::applog;
use crate::config::OrgConfig;
use crate::secrets as kr;
use aws_sdk_ssooidc::config::{BehaviorVersion, Region};
use aws_sdk_ssooidc::operation::create_token::CreateTokenError;
use aws_sdk_ssooidc::Client as OidcClient;
use serde::Serialize;
use serde_json::json;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use super::token_cache::{self, CachedToken};

const CLIENT_NAME: &str = "sleipnir";
const CLIENT_TYPE: &str = "public";
const SCOPE: &str = "sso:account:access";
const GRANT_TYPE_DEVICE_CODE: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Debug, thiserror::Error)]
pub enum LoginError {
    #[error("registering OIDC client: {0}")]
    Register(String),
    #[error("starting device authorization: {0}")]
    StartDeviceAuth(String),
    #[error("opening browser: {0}")]
    OpenBrowser(String),
    #[error("device authorization expired before it was approved")]
    Expired,
    #[error("access denied")]
    AccessDenied,
    #[error("creating token: {0}")]
    CreateToken(String),
    #[error("writing token cache: {0}")]
    Cache(#[from] std::io::Error),
    #[error("storing secret in keyring: {0}")]
    Keyring(#[from] keyring::Error),
}

/// Progress emitted to the frontend on the `sso:login-progress` event while
/// a device-auth login is in flight.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum LoginProgress {
    Registering,
    AwaitingBrowserApproval { verification_uri_complete: String },
    Polling,
    Done,
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn oidc_client(region: &str) -> OidcClient {
    let config = aws_sdk_ssooidc::Config::builder()
        .region(Region::new(region.to_string()))
        .behavior_version(BehaviorVersion::latest())
        .build();
    OidcClient::from_conf(config)
}

async fn get_or_register_client(org: &OrgConfig) -> Result<kr::ClientRegistration, LoginError> {
    if let Some(reg) = kr::load_client_registration(&org.name) {
        return Ok(reg);
    }

    let client = oidc_client(&org.region);
    let out = client
        .register_client()
        .client_name(CLIENT_NAME)
        .client_type(CLIENT_TYPE)
        .scopes(SCOPE)
        .send()
        .await
        .map_err(|e| {
            applog::error(
                format!("{}: RegisterClient failed", org.name),
                &json!({"org": org.name, "region": org.region, "awsError": format!("{e:?}")}),
            );
            LoginError::Register(format!("{e:?}"))
        })?;

    let client_id = out
        .client_id()
        .ok_or_else(|| LoginError::Register("response missing client_id".into()))?
        .to_string();
    let client_secret = out
        .client_secret()
        .ok_or_else(|| LoginError::Register("response missing client_secret".into()))?
        .to_string();
    let expires_at = out.client_secret_expires_at();

    let reg = kr::ClientRegistration { client_id: client_id.clone(), client_secret, expires_at };
    kr::store_client_registration(&org.name, &reg)?;
    applog::info(
        format!("{}: OIDC client registered", org.name),
        &json!({"org": org.name, "clientIdSuffix": &client_id[client_id.len().saturating_sub(6)..], "expiresAt": expires_at}),
    );
    Ok(reg)
}

/// Runs a device-auth login for one Org, emitting `sso:login-progress`
/// events as it goes, and returns a valid cached token. Short-circuits when
/// possible: an unexpired cached token is returned as-is, and an expired
/// one is silently refreshed via a cached refresh token when one exists —
/// only the remaining case (no refresh token, or the refresh itself fails,
/// e.g. it's past its own ~90-day lifetime) needs the browser.
pub async fn login(app: &AppHandle, org: &OrgConfig) -> Result<CachedToken, LoginError> {
    let emit = |progress: LoginProgress| {
        let _ = app.emit("sso:login-progress", &progress);
    };

    // Valid cached token or headless refresh — no browser, no user action.
    if let Some(cached) = ensure_fresh_token(org).await {
        return Ok(cached);
    }

    applog::info(
        format!("{}: starting login", org.name),
        &json!({"org": org.name, "startUrl": org.start_url, "region": org.region}),
    );

    emit(LoginProgress::Registering);
    let reg = get_or_register_client(org).await?;
    let client = oidc_client(&org.region);

    let device_auth = client
        .start_device_authorization()
        .client_id(&reg.client_id)
        .client_secret(&reg.client_secret)
        .start_url(&org.start_url)
        .send()
        .await
        .map_err(|e| {
            applog::error(
                format!("{}: StartDeviceAuthorization failed", org.name),
                &json!({"org": org.name, "awsError": format!("{e:?}")}),
            );
            LoginError::StartDeviceAuth(format!("{e:?}"))
        })?;

    let device_code = device_auth
        .device_code()
        .ok_or_else(|| LoginError::StartDeviceAuth("response missing device_code".into()))?
        .to_string();
    let verification_uri_complete = device_auth
        .verification_uri_complete()
        .ok_or_else(|| LoginError::StartDeviceAuth("response missing verification_uri_complete".into()))?
        .to_string();
    let mut interval_secs = device_auth.interval().max(1) as u64;
    let expires_in = device_auth.expires_in();
    let expires_at_unix = now_unix() + expires_in as i64;

    applog::info(
        format!("{}: opening browser for device approval", org.name),
        &json!({"org": org.name, "verificationUriComplete": verification_uri_complete, "expiresInSecs": expires_in, "pollIntervalSecs": interval_secs}),
    );
    emit(LoginProgress::AwaitingBrowserApproval {
        verification_uri_complete: verification_uri_complete.clone(),
    });
    tauri_plugin_opener::open_url(&verification_uri_complete, None::<&str>)
        .map_err(|e| LoginError::OpenBrowser(e.to_string()))?;

    let mut polls = 0u32;
    loop {
        if now_unix() >= expires_at_unix {
            applog::error(
                format!("{}: device authorization expired before approval", org.name),
                &json!({"org": org.name, "pollsAttempted": polls}),
            );
            return Err(LoginError::Expired);
        }

        tokio::time::sleep(Duration::from_secs(interval_secs)).await;
        polls += 1;
        emit(LoginProgress::Polling);

        let result = client
            .create_token()
            .client_id(&reg.client_id)
            .client_secret(&reg.client_secret)
            .grant_type(GRANT_TYPE_DEVICE_CODE)
            .device_code(&device_code)
            .send()
            .await;

        let output = match result {
            Ok(output) => output,
            Err(err) => {
                let service_err = err.into_service_error();
                match service_err {
                    CreateTokenError::AuthorizationPendingException(_) => continue,
                    CreateTokenError::SlowDownException(_) => {
                        interval_secs += 5;
                        log::info!("{}: AWS asked us to slow polling, interval now {}s", org.name, interval_secs);
                        continue;
                    }
                    CreateTokenError::ExpiredTokenException(_) => {
                        applog::error(
                            format!("{}: device code expired", org.name),
                            &json!({"org": org.name, "pollsAttempted": polls}),
                        );
                        return Err(LoginError::Expired);
                    }
                    CreateTokenError::AccessDeniedException(e) => {
                        applog::error(
                            format!("{}: access denied", org.name),
                            &json!({"org": org.name, "pollsAttempted": polls, "awsError": format!("{e:?}")}),
                        );
                        return Err(LoginError::AccessDenied);
                    }
                    other => {
                        applog::error(
                            format!("{}: CreateToken failed", org.name),
                            &json!({"org": org.name, "pollsAttempted": polls, "awsError": format!("{other:?}")}),
                        );
                        return Err(LoginError::CreateToken(format!("{other:?}")));
                    }
                }
            }
        };

        let cached = finish_login(org, output.access_token(), output.expires_in(), output.refresh_token())?;
        applog::info(
            format!("{}: login complete", org.name),
            &json!({"org": org.name, "expiresAt": cached.expires_at, "pollsTaken": polls}),
        );
        emit(LoginProgress::Done);
        return Ok(cached);
    }
}

/// Headless best-effort session: returns the cached access token when it's
/// still valid, otherwise silently exchanges the keyring refresh token for
/// a fresh one. Never opens a browser. This is what makes the AWS-fixed
/// 1-hour access-token lifetime invisible — the effective session is the
/// refresh token's (the org's configured SSO session length). Returns None
/// only when a real interactive login is required.
pub async fn ensure_fresh_token(org: &OrgConfig) -> Option<CachedToken> {
    if let Some(cached) = token_cache::read(&org.name) {
        if !is_expired(&cached.expires_at) {
            return Some(cached);
        }
    }

    let reg = kr::load_client_registration(&org.name)?;
    let refresh_token = kr::load_refresh_token(&org.name)?;
    let client = oidc_client(&org.region);
    match refresh_access_token(&client, org, &reg, &refresh_token).await {
        Ok(cached) => {
            applog::info(
                format!("{}: access token silently refreshed (no browser)", org.name),
                &json!({"org": org.name, "expiresAt": cached.expires_at}),
            );
            Some(cached)
        }
        Err(e) => {
            applog::warn(
                format!("{}: silent refresh failed — interactive login needed", org.name),
                &json!({"org": org.name, "error": e.to_string()}),
            );
            None
        }
    }
}

/// Exchanges a cached refresh token for a fresh access token — no browser
/// involved. `CreateToken`'s `refresh_token` grant is the same operation as
/// the device-code grant, just with different input fields.
async fn refresh_access_token(
    client: &OidcClient,
    org: &OrgConfig,
    reg: &kr::ClientRegistration,
    refresh_token: &str,
) -> Result<CachedToken, LoginError> {
    let output = client
        .create_token()
        .client_id(&reg.client_id)
        .client_secret(&reg.client_secret)
        .grant_type("refresh_token")
        .refresh_token(refresh_token)
        .send()
        .await
        .map_err(|e| LoginError::CreateToken(format!("{e:?}")))?;

    finish_login(org, output.access_token(), output.expires_in(), output.refresh_token())
}

/// Builds the `CachedToken` from a `CreateToken` response, stashes any
/// rotated refresh token in the keyring, and writes the AWS-CLI-compatible
/// cache file. Shared by the device-auth poll loop and the refresh path.
fn finish_login(
    org: &OrgConfig,
    access_token: Option<&str>,
    expires_in: i32,
    refresh_token: Option<&str>,
) -> Result<CachedToken, LoginError> {
    let access_token = access_token
        .ok_or_else(|| LoginError::CreateToken("response missing access_token".into()))?
        .to_string();
    let expires_at = chrono_free_rfc3339(now_unix() + expires_in as i64);

    if let Some(refresh_token) = refresh_token {
        let _ = kr::store_refresh_token(&org.name, refresh_token);
    }

    let cached = CachedToken {
        start_url: org.start_url.clone(),
        region: org.region.clone(),
        access_token,
        expires_at,
        refresh_token: None,
    };
    token_cache::write(&org.name, &cached)?;
    Ok(cached)
}

pub(crate) fn is_expired(expires_at_rfc3339: &str) -> bool {
    // Zero-padded fixed-width `YYYY-MM-DDTHH:MM:SSZ` sorts lexicographically
    // in chronological order, so this needs no date parsing.
    expires_at_rfc3339 <= chrono_free_rfc3339(now_unix()).as_str()
}

/// RFC3339 UTC formatting without pulling in `chrono` as a dependency —
/// this is the only place a timestamp needs to round-trip through the
/// AWS-CLI-compatible cache file, so a tiny hand-rolled formatter is enough.
pub(crate) fn chrono_free_rfc3339(unix_secs: i64) -> String {
    let days_since_epoch = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days_since_epoch);
    let hour = secs_of_day / 3600;
    let min = (secs_of_day % 3600) / 60;
    let sec = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Howard Hinnant's `civil_from_days` algorithm (public domain), converting
/// a day count since the Unix epoch into a proleptic-Gregorian y/m/d.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_roundtrip_matches_expected_format() {
        // 2026-08-24T23:06:39Z, matching the shape of a real cache file
        // inspected on this machine.
        let unix = 1_787_695_599;
        assert_eq!(chrono_free_rfc3339(unix), "2026-08-25T22:06:39Z");
    }

    /// Not run by default (`cargo test` skips `#[ignore]`d tests) — this
    /// hits the real AWS SSO OIDC `RegisterClient` endpoint and exercises
    /// the one code path (register + keyring cache) that a valid cached
    /// access token would otherwise short-circuit around. Run with:
    ///   SLEIPNIR_TEST_ORG=MyOrg \
    ///   SLEIPNIR_TEST_START_URL=https://my-org.awsapps.com/start \
    ///   SLEIPNIR_TEST_REGION=us-east-2 \
    ///     cargo test --package sleipnir -- --ignored register_client_smoke
    #[tokio::test]
    #[ignore = "hits the real AWS SSO OIDC endpoint"]
    async fn register_client_smoke() {
        let org = OrgConfig {
            name: std::env::var("SLEIPNIR_TEST_ORG").expect("set SLEIPNIR_TEST_ORG"),
            start_url: std::env::var("SLEIPNIR_TEST_START_URL").expect("set SLEIPNIR_TEST_START_URL"),
            region: std::env::var("SLEIPNIR_TEST_REGION").expect("set SLEIPNIR_TEST_REGION"),
        };
        let reg = get_or_register_client(&org).await.expect("register_client should succeed");
        assert!(!reg.client_id.is_empty());
        assert!(!reg.client_secret.is_empty());
        assert!(reg.expires_at > now_unix());
        println!(
            "registered client_id={} expires_at={} (now={})",
            reg.client_id,
            reg.expires_at,
            now_unix()
        );

        // Not asserted: reading it back via a fresh `load_client_registration`
        // call. keyring-rs's macOS backend has a same-process read-after-write
        // staleness quirk for a freshly written item read via a different
        // `Entry` instance (see the doc comment on `load_client_registration`)
        // — this smoke test cares about `RegisterClient` itself succeeding,
        // which it does regardless.
    }
}
