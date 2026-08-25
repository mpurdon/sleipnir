//! Structured-payload logging. Plain `log::info!("did the thing")` gives no
//! debugging leverage when "the thing" is a network call with a request/
//! response shape worth inspecting later. These helpers append a JSON blob
//! after a `||PAYLOAD||` marker that the Developer settings tab's log
//! viewer detects and renders as an expandable details section, instead of
//! forcing everything into one terse text line.

use serde::Serialize;

fn payload_str<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|e| format!("{{\"serializeError\":\"{e}\"}}"))
}

pub fn info(msg: impl AsRef<str>, payload: &impl Serialize) {
    log::info!("{} ||PAYLOAD||{}", msg.as_ref(), payload_str(payload));
}

pub fn warn(msg: impl AsRef<str>, payload: &impl Serialize) {
    log::warn!("{} ||PAYLOAD||{}", msg.as_ref(), payload_str(payload));
}

pub fn error(msg: impl AsRef<str>, payload: &impl Serialize) {
    log::error!("{} ||PAYLOAD||{}", msg.as_ref(), payload_str(payload));
}
