//! AWS SSO account/role discovery — `ListAccounts` + `ListAccountRoles`,
//! called once an Org is logged in. Feeds `crate::discovery`'s grouping
//! heuristic so Project/Account setup wires itself from naming conventions
//! instead of manual entry. See the plan doc's §Auto-discovery.

use aws_sdk_sso::config::{BehaviorVersion, Region};
use aws_sdk_sso::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_sso::Client as SsoClient;
use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::json;
use std::time::Duration;

use crate::applog;
use crate::discovery::RawAccount;
use super::sso_oidc;
use super::token_cache;

/// Concurrent `ListAccountRoles` fan-out width. The SSO portal API
/// throttles aggressively (observed 429s at width 6 over 166 accounts), so
/// stay narrow and let the backoff below absorb whatever still slips
/// through.
const ROLE_FETCH_CONCURRENCY: usize = 3;

/// Per-request retry budget for throttled/transient failures. Backoff
/// doubles from 400ms and caps at 8s, so the worst case is ~40s of waiting
/// before a request is declared dead — generous, because a scan that
/// succeeds slowly beats an error screen.
const MAX_ATTEMPTS: u32 = 8;

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("not logged in to {0} (or the session has expired) — log in first")]
    NotLoggedIn(String),
    #[error("AWS is rate-limiting the scan and it didn't recover after several retries. Wait a minute, then scan again — progress will be faster on a quieter connection.")]
    Throttled,
    #[error("listing accounts failed — {0}")]
    ListAccounts(String),
    #[error("listing roles for account {0} failed — {1}")]
    ListAccountRoles(String, String),
}

/// A one-line, human-readable rendering of an AWS SDK error: the service
/// error code + message when present, the transport-level summary
/// otherwise. The full `Debug` dump belongs in the applog payload, never in
/// the UI.
pub(crate) fn concise_aws_error<E: ProvideErrorMetadata + std::fmt::Debug, R>(e: &SdkError<E, R>) -> String {
    if let Some(se) = e.as_service_error() {
        let code = se.code().unwrap_or("AWS error");
        match se.message() {
            Some(m) => format!("{code}: {m}"),
            None => code.to_string(),
        }
    } else {
        // Display for SdkError gives a short category ("dispatch failure",
        // "request timeout") without the nested struct dump.
        format!("{e}")
    }
}

pub(crate) fn is_retryable<E: ProvideErrorMetadata + std::fmt::Debug, R>(e: &SdkError<E, R>) -> bool {
    match e {
        SdkError::DispatchFailure(_) | SdkError::TimeoutError(_) => true,
        _ => e
            .as_service_error()
            .and_then(|se| se.code())
            .is_some_and(|c| c.contains("TooManyRequests") || c.contains("Throttl")),
    }
}

/// Legacy shape kept for the manual add-account escape hatch UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredAccount {
    pub account_id: String,
    pub account_name: Option<String>,
    pub email_address: Option<String>,
    pub roles: Vec<String>,
}

/// Runs one SDK request with exponential backoff on throttling/transient
/// failures. Emits an applog line per retry so a slow scan is explainable
/// from the Developer tab.
pub(crate) async fn send_retrying<T, E, R, Fut>(
    what: String,
    mut attempt: impl FnMut() -> Fut,
) -> Result<T, SdkError<E, R>>
where
    E: ProvideErrorMetadata + std::fmt::Debug,
    Fut: std::future::Future<Output = Result<T, SdkError<E, R>>>,
{
    let mut delay = Duration::from_millis(400);
    let mut n = 1u32;
    loop {
        match attempt().await {
            Ok(v) => return Ok(v),
            Err(e) if n < MAX_ATTEMPTS && is_retryable(&e) => {
                applog::warn(
                    format!("{what}: throttled — retrying in {}ms (attempt {n}/{MAX_ATTEMPTS})", delay.as_millis()),
                    &json!({
                        "what": what,
                        "attempt": n,
                        "delayMs": delay.as_millis() as u64,
                        "awsError": concise_aws_error(&e),
                    }),
                );
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(8));
                n += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

pub(crate) fn sso_client(region: &str) -> SsoClient {
    let config = aws_sdk_sso::Config::builder()
        .region(Region::new(region.to_string()))
        .behavior_version(BehaviorVersion::latest())
        .build();
    SsoClient::from_conf(config)
}

pub(crate) fn valid_access_token(org_name: &str) -> Result<String, DiscoveryError> {
    let cached = token_cache::read(org_name).ok_or_else(|| DiscoveryError::NotLoggedIn(org_name.to_string()))?;
    if sso_oidc::is_expired(&cached.expires_at) {
        return Err(DiscoveryError::NotLoggedIn(org_name.to_string()));
    }
    Ok(cached.access_token)
}

/// Fetches every account + its assigned roles, calling `on_progress(done,
/// total)` as each account's roles resolve. Role fetches run
/// `ROLE_FETCH_CONCURRENCY`-wide; results keep `ListAccounts` order.
pub async fn fetch_raw_accounts(
    org_name: &str,
    region: &str,
    on_progress: impl Fn(usize, usize) + Send + Sync,
) -> Result<Vec<RawAccount>, DiscoveryError> {
    let access_token = valid_access_token(org_name)?;
    let client = sso_client(region);

    let mut infos = Vec::new();
    let mut next_token: Option<String> = None;
    loop {
        let out = send_retrying(format!("{org_name}: ListAccounts"), || {
            let mut req = client.list_accounts().access_token(&access_token);
            if let Some(t) = &next_token {
                req = req.next_token(t);
            }
            req.send()
        })
        .await
        .map_err(|e| {
            applog::error(
                format!("{org_name}: ListAccounts failed"),
                &json!({"org": org_name, "awsError": format!("{e:?}")}),
            );
            if is_retryable(&e) {
                DiscoveryError::Throttled
            } else {
                DiscoveryError::ListAccounts(concise_aws_error(&e))
            }
        })?;
        infos.extend(out.account_list().to_vec());
        next_token = out.next_token().map(str::to_string);
        if next_token.is_none() {
            break;
        }
    }

    let total = infos.len();
    applog::info(
        format!("{org_name}: ListAccounts returned {total} account(s)"),
        &json!({"org": org_name, "total": total}),
    );

    let done = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<Result<RawAccount, DiscoveryError>> = stream::iter(infos.into_iter())
        .map(|info| {
            let client = &client;
            let access_token = &access_token;
            let done = &done;
            let on_progress = &on_progress;
            async move {
                let account_id = info.account_id().unwrap_or_default().to_string();
                let account_name = info.account_name().unwrap_or_default().to_string();
                let mut roles = Vec::new();
                let mut role_next_token: Option<String> = None;
                loop {
                    let out = send_retrying(format!("ListAccountRoles({account_name})"), || {
                        let mut req = client.list_account_roles().access_token(access_token).account_id(&account_id);
                        if let Some(t) = &role_next_token {
                            req = req.next_token(t);
                        }
                        req.send()
                    })
                    .await
                    .map_err(|e| {
                        applog::error(
                            format!("{account_id}: ListAccountRoles failed"),
                            &json!({"accountId": account_id, "accountName": account_name, "awsError": format!("{e:?}")}),
                        );
                        if is_retryable(&e) {
                            DiscoveryError::Throttled
                        } else {
                            DiscoveryError::ListAccountRoles(account_name.clone(), concise_aws_error(&e))
                        }
                    })?;
                    roles.extend(out.role_list().iter().filter_map(|r| r.role_name().map(str::to_string)));
                    role_next_token = out.next_token().map(str::to_string);
                    if role_next_token.is_none() {
                        break;
                    }
                }

                let finished = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                on_progress(finished, total);

                Ok(RawAccount {
                    account_id,
                    account_name,
                    email_address: info.email_address().map(str::to_string),
                    roles,
                })
            }
        })
        .buffer_unordered(ROLE_FETCH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    // Any single role-fetch failure fails the scan — a partially-roled
    // import would silently produce services with wrong mode availability.
    let mut accounts = Vec::with_capacity(total);
    for r in results {
        accounts.push(r?);
    }
    accounts.sort_by(|a, b| a.account_name.cmp(&b.account_name));

    applog::info(
        format!("{org_name}: role discovery complete for {} account(s)", accounts.len()),
        &json!({"org": org_name, "total": accounts.len()}),
    );
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not run by default — a full live scan against a real org,
    /// exercising the throttle backoff exactly as the SCAN button does.
    /// Requires a valid cached login for the org named in
    /// `SLEIPNIR_TEST_ORG` (region via `SLEIPNIR_TEST_REGION`). Run with:
    ///   SLEIPNIR_TEST_ORG=MyOrg SLEIPNIR_TEST_REGION=us-east-2 \
    ///     cargo test --package sleipnir -- --ignored live_scan_smoke --nocapture
    #[tokio::test]
    #[ignore = "hits the real AWS SSO portal API"]
    async fn live_scan_smoke() {
        let org = std::env::var("SLEIPNIR_TEST_ORG").expect("set SLEIPNIR_TEST_ORG to a logged-in org name");
        let region = std::env::var("SLEIPNIR_TEST_REGION").unwrap_or_else(|_| "us-east-1".into());
        let raw = fetch_raw_accounts(&org, &region, |done, total| {
            if done % 25 == 0 || done == total {
                println!("scanned {done}/{total}");
            }
        })
        .await
        .expect("live scan should survive throttling");
        assert!(!raw.is_empty(), "expected accounts, got none");
        assert!(raw.iter().all(|a| !a.roles.is_empty()), "every account should list roles");

        let grouped = crate::discovery::group_accounts(&org, raw);
        println!(
            "grouped: {} services + {} standalone from {} accounts",
            grouped.services.len(),
            grouped.standalone.len(),
            grouped.total_accounts
        );
    }
}

/// Legacy flat listing for the manual add-account escape hatch.
pub async fn discover_accounts(org_name: &str, region: &str) -> Result<Vec<DiscoveredAccount>, DiscoveryError> {
    let raw = fetch_raw_accounts(org_name, region, |_, _| {}).await?;
    Ok(raw
        .into_iter()
        .map(|a| DiscoveredAccount {
            account_id: a.account_id,
            account_name: Some(a.account_name),
            email_address: a.email_address,
            roles: a.roles,
        })
        .collect())
}
