//! The Store desktop app's update notice (STORE-UPDATE-NOTICE in
//! docs/decisions.md, #1214).
//!
//! A release build of the package the Microsoft Store signs asks the Store
//! whether a newer version exists, tells the user, and opens the Store's pages
//! on request. It never downloads or installs anything: the Store does. Every
//! other build makes no Store call at all.
//!
//! The decisions live in [`Core`], driven by a [`StoreBackend`], an [`Opener`]
//! and a [`Clock`], so the tests drive them without Windows or the Store. The
//! real backend, on Windows, is `WindowsStore`; a development build can use a
//! scripted one instead (`LASTERM_DEV_STORE_UPDATE`).

use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, Runtime};

/// The family of the package the Store distributes.
pub(crate) const STORE_FAMILY: &str = "O2CSI.Lasterm_sx7tynvv0nmw4";
/// Lasterm's page in the Microsoft Store app, with its What's new.
pub(crate) const STORE_PAGE_URI: &str = "ms-windows-store://pdp/?ProductId=9P82QRJ6VDWL";
/// The Microsoft Store's updates page.
pub(crate) const STORE_UPDATES_URI: &str = "ms-windows-store://downloadsandupdates";
/// The file in the configuration directory, beside `close-behavior.json`.
pub(crate) const UPDATES_FILE: &str = "desktop-updates.json";
/// Names the scripted backend's script, in a development build only.
pub(crate) const SCRIPT_ENV: &str = "LASTERM_DEV_STORE_UPDATE";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(15 * 60);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_secs(1);
const DAY: u64 = 86_400;
const WEEK: u64 = 604_800;

const NOT_STORE_BUILD: &str = "not_store_build";
const STALE_OFFER: &str = "stale_offer";
const UNKNOWN_MODE: &str = "unknown_mode";
const LOAD_ERROR: &str = "The update preference could not be loaded";
const UNLOADED_CHOICE: &str =
    "The update preference could not be loaded. Choose a mode under Settings › Desktop › Updates.";
const NO_ANSWER: &str = "The Microsoft Store did not answer";
const STORE_UNAVAILABLE: &str = "The Microsoft Store is not available on this computer right now";

// ── Versions ─────────────────────────────────────────────────────────────────

/// A package version, four unsigned parts, compared part by part.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Version4(pub(crate) [u16; 4]);

impl Version4 {
    /// `a.b.c.d`, each part decimal digits; anything else is `None`.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let parts: Vec<&str> = text.split('.').collect();
        if parts.len() != 4 {
            return None;
        }
        let mut version = [0u16; 4];
        for (slot, part) in version.iter_mut().zip(parts) {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            *slot = part.parse().ok()?;
        }
        Some(Self(version))
    }

    fn four(self) -> String {
        let [a, b, c, d] = self.0;
        format!("{a}.{b}.{c}.{d}")
    }

    /// What the user reads: the first three parts.
    fn three(self) -> String {
        let [a, b, c, _] = self.0;
        format!("{a}.{b}.{c}")
    }
}

// ── Civil time, ISO 8601 ──────────────────────────────────────────────────────

/// `secs` since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ`.
fn iso(secs: u64) -> String {
    let days = (secs / DAY) as i64;
    let rest = secs % DAY;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest / 60) % 60,
        rest % 60
    )
}

/// An ISO 8601 instant as D3 stores them: `YYYY-MM-DDTHH:MM:SS`, an optional
/// fraction of a second (dropped), then `Z` or an offset `±HH:MM`, read as
/// UTC. [`iso`] writes the `Z` form.
fn parse_iso(text: &str) -> Option<u64> {
    if !text.is_ascii() {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |part: &str| -> Option<u64> {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (year, month, day) = (
        number(&text[0..4])?,
        number(&text[5..7])?,
        number(&text[8..10])?,
    );
    let (hour, minute, second) = (
        number(&text[11..13])?,
        number(&text[14..16])?,
        number(&text[17..19])?,
    );
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    let offset: i64 = match rest.as_bytes() {
        [b'Z'] => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (hours, minutes) = (number(&rest[1..3])?, number(&rest[4..6])?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            let seconds = (hours * 3600 + minutes * 60) as i64;
            if *sign == b'+' {
                seconds
            } else {
                -seconds
            }
        }
        _ => return None,
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = days_from_civil(year as i64, month as u32, day as u32);
    if days < 0 || civil_from_days(days) != (year as i64, month as u32, day as u32) {
        return None;
    }
    let local = days * DAY as i64 + (hour * 3600 + minute * 60 + second) as i64;
    u64::try_from(local - offset).ok()
}

// Howard Hinnant's algorithms, proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i64;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

// ── Eligibility ───────────────────────────────────────────────────────────────

/// What the running package says about itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackageFacts {
    pub(crate) family: String,
    pub(crate) store_signed: bool,
    pub(crate) version: Version4,
}

/// The first condition of D1 a build fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ineligible {
    Channel,
    Package,
    Family,
    Signature,
}

impl Ineligible {
    fn as_str(self) -> &'static str {
        match self {
            Ineligible::Channel => "channel",
            Ineligible::Package => "package",
            Ineligible::Family => "family",
            Ineligible::Signature => "signature",
        }
    }
}

/// D1: a release build, a package, the Store's family, the Store's signature.
pub(crate) fn eligibility(
    release: bool,
    package: Option<PackageFacts>,
) -> Result<PackageFacts, Ineligible> {
    if !release {
        return Err(Ineligible::Channel);
    }
    let package = package.ok_or(Ineligible::Package)?;
    if package.family != STORE_FAMILY {
        return Err(Ineligible::Family);
    }
    if !package.store_signed {
        return Err(Ineligible::Signature);
    }
    Ok(package)
}

// ── The Store, the opener and the clock ───────────────────────────────────────

/// One entry of the Store's answer, as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) family: String,
    pub(crate) full_name: String,
    pub(crate) mandatory: bool,
    pub(crate) version: Option<Version4>,
}

/// `CanSilentlyDownloadStorePackageUpdates`, or its read error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Signal {
    True,
    False,
    Error,
}

/// What a query ends with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum QueryOutcome {
    /// The whole answer, read, and the signal read after it.
    Answer { entries: Vec<Entry>, signal: Signal },
    /// The query, or reading its answer, failed (the code says how).
    Failed(String),
    /// The `StoreContext` could not be created or tied to the window.
    ContextFailed(String),
}

/// One entry's reads, each as the Store answered it.
pub(crate) struct EntryReads {
    pub(crate) family: Result<String, String>,
    pub(crate) full_name: Result<String, String>,
    pub(crate) mandatory: Result<bool, String>,
    pub(crate) version: Result<Version4, String>,
}

/// D2: the whole answer (the list's size, then each entry by index), or the
/// first read that failed. Only the version may fail: then none is shown.
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "only the Windows backend reads a Store answer")
)]
pub(crate) fn read_answer(
    size: Result<u32, String>,
    mut entry: impl FnMut(u32) -> Result<EntryReads, String>,
) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for index in 0..size? {
        let reads = entry(index)?;
        entries.push(Entry {
            family: reads.family?,
            full_name: reads.full_name?,
            mandatory: reads.mandatory?,
            version: reads.version.ok(),
        });
    }
    Ok(entries)
}

/// A query in flight.
pub(crate) trait QueryHandle: Send {
    /// Asks the query to stop; what the Store makes of it is logged by the
    /// backend.
    fn cancel(&self) -> Result<(), String>;
}

/// What a query reports, in this order: its native start, the arrival of its
/// answer, then how it ended. The instants are taken where each happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum QueryEvent {
    /// The context exists and the native query started: an attempt (D2),
    /// whose 60 s run from here.
    Started(Instant),
    /// The Store's answer arrived, read or not; the signal may still be read.
    Answered(Instant),
    /// The end, always last.
    Finished(QueryOutcome),
}

pub(crate) type Events = Arc<dyn Fn(QueryEvent) + Send + Sync>;
pub(crate) type SharedLog = Arc<dyn Fn(&str) + Send + Sync>;

/// The Store, as [`Core`] sees it: one query, and nothing that downloads or
/// installs (R-3).
pub(crate) trait StoreBackend: Send + Sync {
    /// Starts `GetAppAndOptionalStorePackageUpdatesAsync`. Its events reach
    /// `events` in order, never from inside this call.
    fn start_query(&self, events: Events) -> Box<dyn QueryHandle>;
}

/// Hands a fixed URI to the system's protocol handler.
pub(crate) trait Opener: Send + Sync {
    fn open(&self, uri: &str) -> Result<(), String>;
}

/// Civil time (seconds since the epoch) and monotonic time, apart.
pub(crate) trait Clock: Send + Sync {
    fn civil(&self) -> u64;
    fn mono(&self) -> Instant;
}

struct SystemClock;

impl Clock for SystemClock {
    fn civil(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0)
    }
    fn mono(&self) -> Instant {
        Instant::now()
    }
}

// ── State the page reads ──────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    Ask,
    Auto,
    Off,
}

impl Mode {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "ask" => Some(Mode::Ask),
            "auto" => Some(Mode::Auto),
            "off" => Some(Mode::Off),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Mode::Ask => "ask",
            Mode::Auto => "auto",
            Mode::Off => "off",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Checking {
    Idle,
    Running,
    Waiting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NoticeKind {
    Updated,
    Mandatory,
    Waiting,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfferView {
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    mandatory: bool,
    signal: Signal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoticeView {
    id: u64,
    kind: NoticeKind,
    text: String,
}

/// `get_update_state`, and the `update-state` event (D10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateState {
    seq: u64,
    eligible: bool,
    mode: Mode,
    running_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    store_error: Option<String>,
    checking: Checking,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    check_error: Option<String>,
    /// When the desktop saw that check fail, which a later attempt does not
    /// change.
    #[serde(skip_serializing_if = "Option::is_none")]
    check_failed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offer: Option<OfferView>,
    wants_dialog: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    save_error: Option<String>,
    notices: Vec<NoticeView>,
}

impl UpdateState {
    /// D10's ineligible shape: nothing else.
    pub(crate) fn ineligible(running_version: String) -> Self {
        UpdateState {
            seq: 1,
            eligible: false,
            mode: Mode::Ask,
            running_version,
            store_error: None,
            checking: Checking::Idle,
            last_checked_at: None,
            last_attempt_at: None,
            check_error: None,
            check_failed_at: None,
            offer: None,
            wants_dialog: false,
            load_error: None,
            save_error: None,
            notices: Vec::new(),
        }
    }
}

// ── The file ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileHealth {
    Missing,
    Good,
    /// Unreadable, unparsable, or without one of the three modes: behaves as
    /// `ask`, and only `set_update_mode` rewrites it (D3).
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Records {
    mode: Mode,
    snoozed: Option<(String, u64)>,
    pending_since: Option<(String, u64)>,
    noticed_mandatory: Option<(String, u64)>,
    noticed_waiting: Option<(String, u64)>,
    last_run_version: Option<Version4>,
}

impl Default for Records {
    fn default() -> Self {
        Records {
            mode: Mode::Ask,
            snoozed: None,
            pending_since: None,
            noticed_mandatory: None,
            noticed_waiting: None,
            last_run_version: None,
        }
    }
}

fn key_at(value: Option<&serde_json::Value>) -> Option<(String, u64)> {
    let object = value?.as_object()?;
    let key = object.get("key")?.as_str()?.to_string();
    let at = parse_iso(object.get("at")?.as_str()?)?;
    Some((key, at))
}

fn read_records(path: &Path) -> (FileHealth, Records) {
    #[expect(
        clippy::disallowed_methods,
        reason = "reads the non-protected desktop update preference"
    )]
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (FileHealth::Missing, Records::default());
        }
        Err(_) => return (FileHealth::Invalid, Records::default()),
    };
    let Ok(serde_json::Value::Object(object)) =
        serde_json::from_str::<serde_json::Value>(&contents)
    else {
        return (FileHealth::Invalid, Records::default());
    };
    let Some(mode) = object
        .get("mode")
        .and_then(|mode| mode.as_str())
        .and_then(Mode::parse)
    else {
        return (FileHealth::Invalid, Records::default());
    };
    // A field of the wrong form is absent; the others are kept.
    let snoozed = object
        .get("snoozedKey")
        .and_then(|key| key.as_str())
        .zip(
            object
                .get("snoozedUntil")
                .and_then(|at| at.as_str())
                .and_then(parse_iso),
        )
        .map(|(key, at)| (key.to_string(), at));
    let noticed = object.get("noticedAt").and_then(|value| value.as_object());
    let records = Records {
        mode,
        snoozed,
        pending_since: key_at(object.get("pendingSince")),
        noticed_mandatory: key_at(noticed.and_then(|n| n.get("mandatory"))),
        noticed_waiting: key_at(noticed.and_then(|n| n.get("waiting"))),
        last_run_version: object
            .get("lastRunVersion")
            .and_then(|version| version.as_str())
            .and_then(Version4::parse),
    };
    (FileHealth::Good, records)
}

fn records_json(records: &Records) -> String {
    let key_at = |entry: &Option<(String, u64)>| {
        entry
            .as_ref()
            .map(|(key, at)| serde_json::json!({ "key": key, "at": iso(*at) }))
    };
    let mut object = serde_json::Map::new();
    object.insert("mode".into(), records.mode.as_str().into());
    if let Some((key, until)) = &records.snoozed {
        object.insert("snoozedKey".into(), key.clone().into());
        object.insert("snoozedUntil".into(), iso(*until).into());
    }
    if let Some(value) = key_at(&records.pending_since) {
        object.insert("pendingSince".into(), value);
    }
    let mut noticed = serde_json::Map::new();
    if let Some(value) = key_at(&records.noticed_mandatory) {
        noticed.insert("mandatory".into(), value);
    }
    if let Some(value) = key_at(&records.noticed_waiting) {
        noticed.insert("waiting".into(), value);
    }
    if !noticed.is_empty() {
        object.insert("noticedAt".into(), noticed.into());
    }
    if let Some(version) = records.last_run_version {
        object.insert("lastRunVersion".into(), version.four().into());
    }
    serde_json::Value::Object(object).to_string()
}

type Replace = Box<dyn Fn(&Path, &Path) -> std::io::Result<()> + Send>;

#[expect(
    clippy::disallowed_methods,
    reason = "replaces the non-protected desktop update preference"
)]
fn rename_replace() -> Replace {
    Box::new(|source, target| std::fs::rename(source, target))
}

// ── The core ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
struct Offer {
    key: String,
    version: Option<Version4>,
    mandatory: bool,
    signal: Signal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Notice {
    id: u64,
    kind: NoticeKind,
    key: Option<String>,
    text: String,
}

struct Running {
    id: u64,
    handle: Box<dyn QueryHandle>,
    /// The native start: the attempt, and the start of its 60 s (D1: making
    /// the context is not bounded).
    started: Option<Instant>,
    /// Its answer arrived within the bound: it is no longer timed.
    answered: bool,
    /// When that answer arrived, in civil time: the check's date (D2).
    answered_civil: Option<u64>,
    /// Reported failed at the timeout; its effects are dropped when it ends.
    timed_out: bool,
}

pub(crate) type Emit = Box<dyn Fn(&UpdateState) + Send>;
pub(crate) type Log = Box<dyn Fn(&str) + Send>;

/// The decisions of D2–D11 for an eligible build.
pub(crate) struct Core {
    this: Weak<Mutex<Core>>,
    running: Version4,
    backend: Arc<dyn StoreBackend>,
    opener: Arc<dyn Opener>,
    clock: Arc<dyn Clock>,
    path: PathBuf,
    replace: Replace,
    health: FileHealth,
    records: Records,
    save_error: Option<String>,
    offer: Option<Offer>,
    last_checked_at: Option<u64>,
    last_attempt_at: Option<u64>,
    check_error: Option<String>,
    check_failed_at: Option<u64>,
    store_error: Option<String>,
    query: Option<Running>,
    next_query_id: u64,
    /// A check due at a monotonic instant: 60 s after the window shows, or
    /// after leaving `off`.
    short_due: Option<Instant>,
    /// The Store context failed: the next tick checks again (D1).
    context_retry: bool,
    /// A daily check that came due during a running check, joined to it (D2).
    daily_joined_at: Option<u64>,
    last_tick: Instant,
    notices: Vec<Notice>,
    next_notice_id: u64,
    seq: u64,
    last_emitted: Option<UpdateState>,
    emit: Emit,
    log: Log,
}

pub(crate) struct CoreParts {
    pub(crate) running: Version4,
    pub(crate) backend: Arc<dyn StoreBackend>,
    pub(crate) opener: Arc<dyn Opener>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) path: PathBuf,
    pub(crate) emit: Emit,
    pub(crate) log: Log,
}

impl Core {
    pub(crate) fn create(parts: CoreParts) -> Arc<Mutex<Core>> {
        Self::create_with_replace(parts, rename_replace())
    }

    fn create_with_replace(parts: CoreParts, replace: Replace) -> Arc<Mutex<Core>> {
        let (health, records) = read_records(&parts.path);
        let now = parts.clock.mono();
        let core = Arc::new(Mutex::new(Core {
            this: Weak::new(),
            running: parts.running,
            backend: parts.backend,
            opener: parts.opener,
            clock: parts.clock,
            path: parts.path,
            replace,
            health,
            records,
            save_error: None,
            offer: None,
            last_checked_at: None,
            last_attempt_at: None,
            check_error: None,
            check_failed_at: None,
            store_error: None,
            query: None,
            next_query_id: 1,
            short_due: None,
            context_retry: false,
            daily_joined_at: None,
            last_tick: now,
            notices: Vec::new(),
            next_notice_id: 1,
            seq: 0,
            last_emitted: None,
            emit: parts.emit,
            log: parts.log,
        }));
        {
            let mut guard = core.lock().expect("store update core lock poisoned");
            guard.this = Arc::downgrade(&core);
            guard.start_notice();
        }
        core
    }

    /// D11: a lower recorded version gives the `updated` notice; otherwise the
    /// running version is recorded now.
    fn start_notice(&mut self) {
        match self.records.last_run_version {
            Some(recorded) if recorded < self.running => {
                let text = format!("Lasterm was updated to {}.", self.running.three());
                self.push_notice(NoticeKind::Updated, None, text);
            }
            Some(recorded) if recorded == self.running => {}
            _ => {
                self.records.last_run_version = Some(self.running);
                let _ = self.persist();
            }
        }
    }

    fn push_notice(&mut self, kind: NoticeKind, key: Option<String>, text: String) {
        let id = self.next_notice_id;
        self.next_notice_id += 1;
        self.notices.push(Notice {
            id,
            kind,
            key,
            text,
        });
    }

    /// The window has shown: the first check is due 60 s later (D2).
    pub(crate) fn window_shown(&mut self) {
        self.short_due = Some(self.clock.mono() + FIRST_CHECK_DELAY);
    }

    /// Writes the records, unless the file is invalid (D3).
    fn persist(&mut self) -> Result<(), String> {
        if self.health == FileHealth::Invalid {
            return Ok(());
        }
        self.write_records(&self.records.clone())
    }

    fn write_records(&mut self, records: &Records) -> Result<(), String> {
        let contents = records_json(records);
        let replace = &self.replace;
        let result = crate::write_preference_file_with_replace(
            &self.path,
            contents.as_bytes(),
            "update preference",
            |source, target| replace(source, target),
        );
        match &result {
            Ok(()) => {
                self.health = FileHealth::Good;
                self.save_error = None;
            }
            Err(error) => self.save_error = Some(error.clone()),
        }
        result
    }

    fn snoozed(&self, key: &str, civil: u64) -> bool {
        matches!(&self.records.snoozed, Some((snoozed, until)) if snoozed == key && civil < *until)
    }

    fn wants_dialog(&self, civil: u64) -> bool {
        let Some(offer) = &self.offer else {
            return false;
        };
        if self.snoozed(&offer.key, civil) {
            return false;
        }
        match self.records.mode {
            Mode::Ask => true,
            Mode::Auto => offer.signal != Signal::True,
            Mode::Off => false,
        }
    }

    fn checking(&self) -> Checking {
        match &self.query {
            None => Checking::Idle,
            Some(running) if running.timed_out => Checking::Waiting,
            Some(_) => Checking::Running,
        }
    }

    /// The state as of now; the `seq` is the last one published.
    pub(crate) fn state(&self) -> UpdateState {
        let civil = self.clock.civil();
        UpdateState {
            seq: self.seq,
            eligible: true,
            mode: self.records.mode,
            running_version: self.running.four(),
            store_error: self.store_error.clone(),
            checking: self.checking(),
            last_checked_at: self.last_checked_at.map(iso),
            last_attempt_at: self.last_attempt_at.map(iso),
            check_error: self.check_error.clone(),
            check_failed_at: self.check_failed_at.map(iso),
            offer: self.offer.as_ref().map(|offer| OfferView {
                key: offer.key.clone(),
                version: offer.version.map(Version4::three),
                mandatory: offer.mandatory,
                signal: offer.signal,
            }),
            wants_dialog: self.wants_dialog(civil),
            load_error: (self.health == FileHealth::Invalid).then(|| LOAD_ERROR.to_string()),
            save_error: self.save_error.clone(),
            notices: self
                .notices
                .iter()
                .map(|notice| NoticeView {
                    id: notice.id,
                    kind: notice.kind,
                    text: notice.text.clone(),
                })
                .collect(),
        }
    }

    /// Publishes the state when it differs from the last one published.
    fn publish(&mut self) {
        let mut state = self.state();
        if let Some(previous) = &self.last_emitted {
            let mut same = previous.clone();
            same.seq = state.seq;
            if same == state {
                return;
            }
        }
        self.seq += 1;
        state.seq = self.seq;
        (self.emit)(&state);
        self.last_emitted = Some(state);
    }

    /// What the commands answer: published first when it changed, so one `seq`
    /// never carries two different states (D10).
    pub(crate) fn current(&mut self) -> UpdateState {
        self.publish();
        match &self.last_emitted {
            Some(state) => state.clone(),
            None => self.state(),
        }
    }

    /// D6: the `mandatory` and `waiting` notices that hold now.
    fn refresh_notices(&mut self) {
        let civil = self.clock.civil();
        let offer = self.offer.clone();
        let quiet = self.records.mode == Mode::Auto
            && offer
                .as_ref()
                .is_some_and(|offer| offer.signal == Signal::True);
        let key = offer.as_ref().map(|offer| offer.key.clone());
        let mandatory = quiet && offer.as_ref().is_some_and(|offer| offer.mandatory);
        let waiting = quiet
            && matches!((&self.records.pending_since, &key),
                (Some((pending, at)), Some(key)) if pending == key && civil.saturating_sub(*at) >= WEEK);
        for (kind, holds) in [
            (NoticeKind::Mandatory, mandatory),
            (NoticeKind::Waiting, waiting),
        ] {
            // A notice of another key, or whose predicate fell, goes.
            self.notices.retain(|notice| {
                notice.kind != kind || (holds && notice.key.as_ref() == key.as_ref())
            });
            if !holds || self.notices.iter().any(|notice| notice.kind == kind) {
                continue;
            }
            let noticed = match kind {
                NoticeKind::Mandatory => &self.records.noticed_mandatory,
                _ => &self.records.noticed_waiting,
            };
            let key = key.clone().unwrap_or_default();
            if matches!(noticed, Some((noticed_key, at)) if *noticed_key == key && civil.saturating_sub(*at) < DAY)
            {
                continue;
            }
            let text = match kind {
                NoticeKind::Mandatory => "A required Lasterm update is available. The Microsoft Store should install it while Lasterm is closed; you can also update now from Settings.",
                _ => "A Lasterm update has been waiting 7 days. The Microsoft Store should install it while Lasterm is not running; you can also update now from Settings.",
            };
            self.push_notice(kind, Some(key), text.to_string());
        }
    }

    /// Starts a check, or joins the running one. `false` while a timed-out
    /// query has not returned.
    fn start_check(&mut self) -> bool {
        if let Some(running) = &self.query {
            return !running.timed_out;
        }
        let id = self.next_query_id;
        self.next_query_id += 1;
        // Any check tries the context again.
        self.context_retry = false;
        let core = self.this.clone();
        let handle = self.backend.start_query(Arc::new(move |event| {
            if let Some(core) = core.upgrade() {
                lock(&core).on_event(id, event);
            }
        }));
        self.query = Some(Running {
            id,
            handle,
            started: None,
            answered: false,
            answered_civil: None,
            timed_out: false,
        });
        self.publish();
        true
    }

    fn fail_check(&mut self, line: &str, error: String) {
        (self.log)(&format!("update check: failed {line}"));
        self.check_error = Some(error);
        self.check_failed_at = Some(self.clock.civil());
        // The offer is kept, and its notices may have come due (D6).
        self.refresh_notices();
    }

    /// The native query of check `id` started: an attempt, and the context
    /// exists (D1, D2).
    fn mark_started(&mut self, at: Instant) {
        if let Some(running) = self.query.as_mut() {
            if running.started.is_none() {
                running.started = Some(at);
                self.last_attempt_at = Some(self.clock.civil());
                self.store_error = None;
            }
        }
    }

    fn on_event(&mut self, id: u64, event: QueryEvent) {
        if self.query.as_ref().map(|running| running.id) != Some(id) {
            return;
        }
        match event {
            QueryEvent::Started(at) => {
                self.mark_started(at);
                self.publish();
            }
            QueryEvent::Answered(at) => {
                let running = self.query.as_mut().expect("checked above");
                if running.timed_out {
                    return;
                }
                let late = running
                    .started
                    .is_some_and(|started| at.saturating_duration_since(started) >= QUERY_TIMEOUT);
                if late {
                    // Past the bound before the poller saw it: no answer,
                    // reported, then asked to stop (D2).
                    running.timed_out = true;
                    self.fail_check("no answer", NO_ANSWER.to_string());
                    self.publish();
                    if let Some(Err(error)) =
                        self.query.as_ref().map(|running| running.handle.cancel())
                    {
                        (self.log)(&format!("store result: Cancel failed {error}"));
                    }
                } else {
                    running.answered = true;
                    running.answered_civil = Some(self.clock.civil());
                }
            }
            QueryEvent::Finished(outcome) => self.on_finished(outcome),
        }
    }

    fn on_finished(&mut self, outcome: QueryOutcome) {
        if self
            .query
            .as_ref()
            .is_some_and(|running| running.started.is_none())
            && !matches!(outcome, QueryOutcome::ContextFailed(_))
        {
            // Its start was not reported: an answer implies it.
            self.mark_started(self.clock.mono());
        }
        let running = self.query.take().expect("a query is running");
        if running.timed_out {
            (self.log)("store result: GetAppAndOptionalStorePackageUpdatesAsync late, ignored");
            self.publish();
            return;
        }
        match outcome {
            QueryOutcome::ContextFailed(reason) => {
                self.store_error = Some(STORE_UNAVAILABLE.to_string());
                self.fail_check(&format!("context {reason}"), STORE_UNAVAILABLE.to_string());
                self.context_retry = true;
            }
            QueryOutcome::Failed(code) => {
                let error = format!("The Microsoft Store could not answer ({code})");
                self.fail_check(&code, error);
            }
            QueryOutcome::Answer { entries, signal } => {
                self.check_error = None;
                self.check_failed_at = None;
                self.last_checked_at = Some(running.answered_civil.unwrap_or(self.clock.civil()));
                self.apply_answer(entries, signal);
            }
        }
        self.publish();
    }

    fn apply_answer(&mut self, entries: Vec<Entry>, signal: Signal) {
        let ours: Vec<&Entry> = entries
            .iter()
            .filter(|entry| entry.family == STORE_FAMILY)
            .collect();
        let Some(first) = ours.first() else {
            (self.log)("update check: none");
            self.offer = None;
            let changed = self.records.pending_since.is_some() || self.records.snoozed.is_some();
            self.records.pending_since = None;
            self.records.snoozed = None;
            self.notices
                .retain(|notice| notice.kind == NoticeKind::Updated);
            // Nothing to write when nothing changed and no earlier write failed.
            if changed || self.save_error.is_some() {
                let _ = self.persist();
            }
            return;
        };
        let offer = Offer {
            key: first.full_name.clone(),
            version: first.version.filter(|version| *version > self.running),
            mandatory: ours.iter().any(|entry| entry.mandatory),
            signal,
        };
        (self.log)(&format!(
            "update check: offer {} {} mandatory={} signal={}",
            offer.key,
            first
                .version
                .map(Version4::four)
                .unwrap_or_else(|| "unknown".into()),
            offer.mandatory,
            match signal {
                Signal::True => "true",
                Signal::False => "false",
                Signal::Error => "error",
            }
        ));
        let mut changed = false;
        if self.records.mode == Mode::Auto
            && self.records.pending_since.as_ref().map(|(key, _)| key) != Some(&offer.key)
        {
            self.records.pending_since = Some((offer.key.clone(), self.clock.civil()));
            changed = true;
        }
        self.offer = Some(offer);
        self.refresh_notices();
        if changed {
            let _ = self.persist();
        }
    }

    /// Called every second: timeouts, short dues, and the 15-minute tick.
    fn poll(&mut self) {
        let mono = self.clock.mono();
        let expired = self.query.as_ref().is_some_and(|running| {
            !running.timed_out
                && !running.answered
                && running
                    .started
                    .is_some_and(|started| mono.saturating_duration_since(started) >= QUERY_TIMEOUT)
        });
        if expired {
            if let Some(running) = self.query.as_mut() {
                running.timed_out = true;
            }
            // Reported first, then asked to stop (D2).
            self.fail_check("no answer", NO_ANSWER.to_string());
            self.publish();
            if let Some(Err(error)) = self.query.as_ref().map(|running| running.handle.cancel()) {
                (self.log)(&format!("store result: Cancel failed {error}"));
            }
        }
        if self.records.mode != Mode::Off {
            if let Some(due) = self.short_due {
                if mono >= due {
                    match &self.query {
                        // A check running now satisfies it.
                        Some(running) if !running.timed_out => self.short_due = None,
                        // Due again once the timed-out query has returned.
                        Some(_) => {}
                        None => {
                            self.short_due = None;
                            self.start_check();
                        }
                    }
                }
            }
        }
        if mono.duration_since(self.last_tick) >= TICK {
            self.last_tick = mono;
            let civil = self.clock.civil();
            let since = self.last_attempt_at.max(self.daily_joined_at);
            let daily = self.records.mode != Mode::Off
                && since.is_some_and(|at| civil.saturating_sub(at) >= DAY);
            match &self.query {
                // A short due pending decides the next scheduled check itself.
                None if self.records.mode != Mode::Off && self.short_due.is_none() => {
                    if daily || self.context_retry {
                        self.start_check();
                    }
                }
                // Due during a running check: that check satisfies it (D2).
                Some(running) if daily && !running.timed_out => {
                    self.daily_joined_at = Some(civil);
                }
                _ => {}
            }
            self.refresh_notices();
            self.publish();
        }
    }

    /// Check for updates: starts or joins a check, and answers the state, the
    /// waiting one included (D2).
    pub(crate) fn check_now(&mut self) -> UpdateState {
        self.start_check();
        self.current()
    }

    /// A mode change, written with the records it implies, in one step.
    fn change_mode(&mut self, mode: Mode, snooze: Option<String>) -> Result<(), String> {
        let previous = self.records.mode;
        let civil = self.clock.civil();
        let mut records = self.records.clone();
        records.mode = mode;
        if mode == Mode::Off {
            records.pending_since = None;
            records.snoozed = None;
        }
        if mode == Mode::Auto {
            if let Some(offer) = &self.offer {
                if records.pending_since.as_ref().map(|(key, _)| key) != Some(&offer.key) {
                    records.pending_since = Some((offer.key.clone(), civil));
                }
            }
        }
        if let Some(key) = snooze {
            if self.offer.as_ref().is_some_and(|offer| offer.key == key) {
                records.snoozed = Some((key, civil + DAY));
            }
        }
        // A failed mode change returns its error to the caller and changes no
        // state: `saveError` is for the other records (D3).
        let save_error = self.save_error.clone();
        if let Err(error) = self.write_records(&records) {
            self.save_error = save_error;
            return Err(error);
        }
        self.records = records;
        if previous == Mode::Off && mode != Mode::Off {
            self.short_due = Some(self.clock.mono() + FIRST_CHECK_DELAY);
        }
        if mode == Mode::Off {
            self.notices
                .retain(|notice| notice.kind == NoticeKind::Updated);
        }
        self.refresh_notices();
        self.publish();
        Ok(())
    }

    pub(crate) fn set_mode(&mut self, mode: &str) -> Result<(), String> {
        let mode = Mode::parse(mode).ok_or_else(|| UNKNOWN_MODE.to_string())?;
        self.change_mode(mode, None)
    }

    /// Always update. An unreadable file is rewritten by the Updates setting
    /// alone (D3), so it refuses then.
    pub(crate) fn choose_always_update(&mut self, key: String) -> Result<(), String> {
        if self.health == FileHealth::Invalid {
            return Err(UNLOADED_CHOICE.to_string());
        }
        self.change_mode(Mode::Auto, Some(key))
    }

    /// Later (D5). `Ok(false)` when the snooze holds in memory only: its write
    /// failed, or the file is unreadable and left as it is (D3).
    pub(crate) fn snooze(&mut self, key: &str) -> Result<bool, String> {
        if self.offer.as_ref().map(|offer| offer.key.as_str()) != Some(key) {
            return Err(STALE_OFFER.to_string());
        }
        self.records.snoozed = Some((key.to_string(), self.clock.civil() + DAY));
        let saved = self.health != FileHealth::Invalid && self.persist().is_ok();
        self.publish();
        Ok(saved)
    }

    pub(crate) fn acknowledge(&mut self, id: u64) {
        let Some(index) = self.notices.iter().position(|notice| notice.id == id) else {
            return;
        };
        let notice = self.notices.remove(index);
        let civil = self.clock.civil();
        match notice.kind {
            NoticeKind::Updated => self.records.last_run_version = Some(self.running),
            NoticeKind::Mandatory => {
                self.records.noticed_mandatory = notice.key.map(|key| (key, civil));
            }
            NoticeKind::Waiting => {
                self.records.noticed_waiting = notice.key.map(|key| (key, civil));
            }
        }
        let _ = self.persist();
        self.publish();
    }

    fn opener(&self) -> Arc<dyn Opener> {
        self.opener.clone()
    }

    fn log_line(&self, line: &str) {
        (self.log)(line);
    }
}

/// Opens a Store link without holding the core's lock (D9).
fn open_link(core: &Mutex<Core>, which: &str, uri: &str) -> Result<(), String> {
    let opener = core
        .lock()
        .expect("store update core lock poisoned")
        .opener();
    let result = opener.open(uri);
    let line = match &result {
        Ok(()) => format!("store link: {which} accepted"),
        Err(error) => format!("store link: {which} refused {error}"),
    };
    core.lock()
        .expect("store update core lock poisoned")
        .log_line(&line);
    result.map_err(|_| "The Microsoft Store could not be opened.".to_string())
}

/// See what's new, and the `updated` notice's action (D9).
fn open_page(core: &Mutex<Core>) -> Result<(), String> {
    open_link(core, "page", STORE_PAGE_URI)
}

/// Update now (D8).
fn open_updates(core: &Mutex<Core>) -> Result<(), String> {
    open_link(core, "updates", STORE_UPDATES_URI)
}

// ── The service the commands reach ────────────────────────────────────────────

pub(crate) enum UpdateService {
    Ineligible(Box<UpdateState>),
    Eligible(Arc<Mutex<Core>>),
}

impl UpdateService {
    fn core(&self) -> Result<&Arc<Mutex<Core>>, String> {
        match self {
            UpdateService::Ineligible(_) => Err(NOT_STORE_BUILD.to_string()),
            UpdateService::Eligible(core) => Ok(core),
        }
    }
}

fn lock(core: &Mutex<Core>) -> std::sync::MutexGuard<'_, Core> {
    core.lock().expect("store update core lock poisoned")
}

#[tauri::command]
fn get_update_state(service: tauri::State<'_, UpdateService>) -> UpdateState {
    match service.inner() {
        UpdateService::Ineligible(state) => (**state).clone(),
        UpdateService::Eligible(core) => lock(core).current(),
    }
}

#[tauri::command]
fn set_update_mode(service: tauri::State<'_, UpdateService>, mode: String) -> Result<(), String> {
    lock(service.core()?).set_mode(&mode)
}

#[tauri::command]
fn choose_always_update(
    service: tauri::State<'_, UpdateService>,
    key: String,
) -> Result<(), String> {
    lock(service.core()?).choose_always_update(key)
}

#[tauri::command]
fn check_for_updates(service: tauri::State<'_, UpdateService>) -> Result<UpdateState, String> {
    Ok(lock(service.core()?).check_now())
}

#[tauri::command]
fn snooze_update(service: tauri::State<'_, UpdateService>, key: String) -> Result<bool, String> {
    lock(service.core()?).snooze(&key)
}

#[tauri::command]
fn open_store_page(service: tauri::State<'_, UpdateService>) -> Result<(), String> {
    open_page(service.core()?)
}

#[tauri::command]
fn open_store_updates(service: tauri::State<'_, UpdateService>) -> Result<(), String> {
    open_updates(service.core()?)
}

#[tauri::command]
fn acknowledge_notice(
    service: tauri::State<'_, UpdateService>,
    notice_id: u64,
) -> Result<(), String> {
    lock(service.core()?).acknowledge(notice_id);
    Ok(())
}

/// The update commands' names: what [`with_update_commands`] routes to them.
pub(crate) const COMMANDS: &[&str] = &[
    "get_update_state",
    "set_update_mode",
    "choose_always_update",
    "check_for_updates",
    "snooze_update",
    "open_store_page",
    "open_store_updates",
    "acknowledge_notice",
];

fn invoke_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        get_update_state,
        set_update_mode,
        choose_always_update,
        check_for_updates,
        snooze_update,
        open_store_page,
        open_store_updates,
        acknowledge_notice
    ]
}

/// The desktop's invoke handler: the update commands, by [`COMMANDS`], and
/// `rest` for every other. Production and the tests install this same
/// dispatch (D10).
pub(crate) fn with_update_commands<R: Runtime>(
    rest: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    let updates = invoke_handler::<R>();
    move |invoke: tauri::ipc::Invoke<R>| {
        if COMMANDS.contains(&invoke.message.command()) {
            updates(invoke)
        } else {
            rest(invoke)
        }
    }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

/// Where the Store answers come from in an eligible build.
pub(crate) enum Source {
    Native,
    Scripted(ScriptedStore),
}

pub(crate) struct Chosen {
    running: Version4,
    source: Source,
    path: PathBuf,
}

/// D1, once at start, with its one log line. `package` is read in a release
/// build only, and the script in a development build only.
pub(crate) fn choose(
    release: bool,
    package: &dyn Fn() -> Option<PackageFacts>,
    script: Option<OsString>,
    config_dir: &dyn Fn() -> Result<PathBuf, String>,
    say: &dyn Fn(&str),
) -> Option<Chosen> {
    let picked = if release {
        eligibility(true, package())
            .map(|package| (package.version, Source::Native))
            .map_err(Some)
    } else {
        match script {
            None => Err(Some(Ineligible::Channel)),
            Some(path) => match ScriptedStore::load(Path::new(&path)) {
                Ok((version, store)) => Ok((version, Source::Scripted(store))),
                Err(error) => {
                    say(&format!("WARN: store updates: invalid script ({error})"));
                    Err(None)
                }
            },
        }
    };
    let (running, source) = match picked {
        Ok(picked) => picked,
        Err(Some(reason)) => {
            say(&format!("store updates: ineligible ({})", reason.as_str()));
            return None;
        }
        Err(None) => return None,
    };
    match config_dir() {
        Ok(dir) => {
            say("store updates: eligible");
            Some(Chosen {
                running,
                source,
                path: dir.join(UPDATES_FILE),
            })
        }
        Err(error) => {
            say(&format!(
                "store updates: ineligible (config directory: {error})"
            ));
            None
        }
    }
}

/// What [`service`] builds an eligible build's core from. An ineligible build
/// uses none of it.
pub(crate) struct Wiring {
    pub(crate) own_version: String,
    pub(crate) backend: Box<dyn FnOnce(Source) -> Arc<dyn StoreBackend>>,
    pub(crate) opener: Arc<dyn Opener>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) emit: Emit,
    pub(crate) log: Log,
    /// Starts what calls `poll` every second.
    pub(crate) poller: Box<dyn FnOnce(Weak<Mutex<Core>>)>,
}

/// The service for what [`choose`] decided: an ineligible build gets no
/// backend, no core and no poller (D1).
pub(crate) fn service(chosen: Option<Chosen>, wiring: Wiring) -> UpdateService {
    let Some(chosen) = chosen else {
        return UpdateService::Ineligible(Box::new(UpdateState::ineligible(wiring.own_version)));
    };
    let backend = (wiring.backend)(chosen.source);
    let core = Core::create(CoreParts {
        running: chosen.running,
        backend,
        opener: wiring.opener,
        clock: wiring.clock,
        path: chosen.path,
        emit: wiring.emit,
        log: wiring.log,
    });
    lock(&core).window_shown();
    (wiring.poller)(Arc::downgrade(&core));
    UpdateService::Eligible(core)
}

/// Decides eligibility and manages the service.
pub(crate) fn install<R: Runtime>(app: &tauri::AppHandle<R>, log: crate::hub_log::HubLog) {
    let release = crate::channel::build_channel() == crate::channel::Channel::Release;
    let say: SharedLog = Arc::new(move |line: &str| log.record(&format!("[store] {line}")));
    let chosen = choose(
        release,
        &current_package,
        std::env::var_os(SCRIPT_ENV),
        &crate::lasterm_config_dir,
        &*say,
    );
    let native_app = app.clone();
    let backend_log = say.clone();
    let emitter = app.clone();
    let core_log = say.clone();
    app.manage(service(
        chosen,
        Wiring {
            own_version: app.package_info().version.to_string(),
            backend: Box::new(move |source| match source {
                Source::Native => native_backend(&native_app, backend_log),
                Source::Scripted(store) => Arc::new(ScriptedStore {
                    log: Some(backend_log),
                    ..store
                }),
            }),
            opener: Arc::new(SystemOpener),
            clock: Arc::new(SystemClock),
            emit: Box::new(move |state| {
                let _ = emitter.emit_to("main", "update-state", state);
            }),
            log: Box::new(move |line| core_log(line)),
            poller: Box::new(|core| {
                std::thread::spawn(move || loop {
                    std::thread::sleep(POLL);
                    let Some(core) = core.upgrade() else { return };
                    lock(&core).poll();
                });
            }),
        },
    ));
}

// ── The scripted backend (tests and Windows Sandbox only) ─────────────────────

#[derive(Clone, Debug)]
enum ScriptCheck {
    Answer { entries: Vec<Entry>, signal: Signal },
    Failed(String),
    ContextFailed(String),
    NoAnswer,
}

pub(crate) struct ScriptedStore {
    checks: Vec<ScriptCheck>,
    next: Mutex<usize>,
    /// Where it records each call it stands in for (D1).
    log: Option<SharedLog>,
}

/// The scripted query's Cancel, recorded like its other calls.
struct ScriptedCancel(Option<SharedLog>);
impl QueryHandle for ScriptedCancel {
    fn cancel(&self) -> Result<(), String> {
        if let Some(log) = &self.0 {
            log("store call (scripted): Cancel");
        }
        Ok(())
    }
}

/// A script field: absent is `None`; present, it must have its form.
fn script_field<'a, T>(
    object: &'a serde_json::Value,
    name: &str,
    read: impl Fn(&'a serde_json::Value) -> Option<T>,
) -> Result<Option<T>, String> {
    match object.get(name) {
        None => Ok(None),
        Some(value) => read(value)
            .map(Some)
            .ok_or_else(|| format!("{name} has the wrong form")),
    }
}

impl ScriptedStore {
    /// `{ "version": "a.b.c.d", "checks": [ … ] }`; each check is
    /// `{ "offers": [{ "key", "version"?, "mandatory"?, "family"? }], "signal"? }`
    /// with the signal `"true"` (when absent), `"false"` or `"error"`,
    /// `{ "error": "0x…" }`, `{ "contextError": "…" }` or `{ "noAnswer": true }`.
    /// A field of the wrong form refuses the script. The last check repeats.
    pub(crate) fn load(path: &Path) -> Result<(Version4, ScriptedStore), String> {
        #[expect(
            clippy::disallowed_methods,
            reason = "reads the development-only scripted Store answers"
        )]
        let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        Self::parse(&text)
    }

    fn parse(text: &str) -> Result<(Version4, ScriptedStore), String> {
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|error| error.to_string())?;
        let version = value
            .get("version")
            .and_then(|version| version.as_str())
            .and_then(Version4::parse)
            .ok_or("no valid version")?;
        let checks = value
            .get("checks")
            .and_then(|checks| checks.as_array())
            .filter(|checks| !checks.is_empty())
            .ok_or("no checks")?
            .iter()
            .map(Self::parse_check)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            version,
            ScriptedStore {
                checks,
                next: Mutex::new(0),
                log: None,
            },
        ))
    }

    fn parse_check(check: &serde_json::Value) -> Result<ScriptCheck, String> {
        const FIELDS: [&str; 5] = ["error", "contextError", "noAnswer", "offers", "signal"];
        let object = check.as_object().ok_or("a check that is not an object")?;
        if let Some(unknown) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
            return Err(format!("unknown field {unknown}"));
        }
        let text = |value: &serde_json::Value| value.as_str().map(str::to_string);
        // Every field is read, so one of the wrong form refuses the script
        // whichever form the check takes.
        let error = script_field(check, "error", text)?;
        let context = script_field(check, "contextError", text)?;
        let no_answer = script_field(check, "noAnswer", |value| {
            (value.as_bool() == Some(true)).then_some(())
        })?;
        let offers = script_field(check, "offers", |value| value.as_array())?;
        let signal = script_field(check, "signal", |value| match value.as_str()? {
            "true" => Some(Signal::True),
            "false" => Some(Signal::False),
            "error" => Some(Signal::Error),
            _ => None,
        })?;
        let forms = [
            error.is_some(),
            context.is_some(),
            no_answer.is_some(),
            offers.is_some(),
        ];
        if forms.iter().filter(|form| **form).count() != 1 {
            return Err(
                "a check takes exactly one of error, contextError, noAnswer, offers".into(),
            );
        }
        if signal.is_some() && offers.is_none() {
            return Err("a signal belongs to a check with offers".into());
        }
        if let Some(code) = error {
            return Ok(ScriptCheck::Failed(code));
        }
        if let Some(reason) = context {
            return Ok(ScriptCheck::ContextFailed(reason));
        }
        if no_answer.is_some() {
            return Ok(ScriptCheck::NoAnswer);
        }
        let signal = signal.unwrap_or(Signal::True);
        let entries = offers
            .ok_or("a check without offers")?
            .iter()
            .map(|offer| -> Result<Entry, String> {
                Ok(Entry {
                    family: script_field(offer, "family", text)?
                        .unwrap_or_else(|| STORE_FAMILY.to_string()),
                    full_name: script_field(offer, "key", text)?.ok_or("an offer without key")?,
                    mandatory: script_field(offer, "mandatory", |value| value.as_bool())?
                        .unwrap_or(false),
                    version: script_field(offer, "version", |value| {
                        value.as_str().and_then(Version4::parse)
                    })?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ScriptCheck::Answer { entries, signal })
    }
}

impl StoreBackend for ScriptedStore {
    fn start_query(&self, events: Events) -> Box<dyn QueryHandle> {
        let mut next = self.next.lock().expect("scripted store lock poisoned");
        let check = self.checks[(*next).min(self.checks.len() - 1)].clone();
        *next += 1;
        if let Some(log) = &self.log {
            match &check {
                ScriptCheck::ContextFailed(reason) => {
                    log("store call (scripted): GetDefault");
                    log(&format!("store result (scripted): GetDefault {reason}"));
                }
                ScriptCheck::Answer { entries, .. } => {
                    log("store call (scripted): GetAppAndOptionalStorePackageUpdatesAsync");
                    if entries.iter().any(|entry| entry.family == STORE_FAMILY) {
                        log("store call (scripted): CanSilentlyDownloadStorePackageUpdates");
                    }
                }
                ScriptCheck::Failed(_) | ScriptCheck::NoAnswer => {
                    log("store call (scripted): GetAppAndOptionalStorePackageUpdatesAsync");
                }
            }
        }
        // In order, from a thread of their own.
        std::thread::spawn(move || match check {
            ScriptCheck::ContextFailed(reason) => {
                events(QueryEvent::Finished(QueryOutcome::ContextFailed(reason)));
            }
            ScriptCheck::NoAnswer => events(QueryEvent::Started(Instant::now())),
            ScriptCheck::Failed(code) => {
                events(QueryEvent::Started(Instant::now()));
                events(QueryEvent::Answered(Instant::now()));
                events(QueryEvent::Finished(QueryOutcome::Failed(code)));
            }
            ScriptCheck::Answer { entries, signal } => {
                events(QueryEvent::Started(Instant::now()));
                events(QueryEvent::Answered(Instant::now()));
                events(QueryEvent::Finished(QueryOutcome::Answer {
                    entries,
                    signal,
                }));
            }
        });
        Box::new(ScriptedCancel(self.log.clone()))
    }
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn current_package() -> Option<PackageFacts> {
    use windows::ApplicationModel::{Package, PackageSignatureKind};
    let package = Package::Current().ok()?;
    let id = package.Id().ok()?;
    let version = id.Version().ok()?;
    Some(PackageFacts {
        family: id.FamilyName().ok()?.to_string(),
        store_signed: package.SignatureKind().ok()? == PackageSignatureKind::Store,
        version: Version4([
            version.Major,
            version.Minor,
            version.Build,
            version.Revision,
        ]),
    })
}

#[cfg(not(windows))]
fn current_package() -> Option<PackageFacts> {
    None
}

#[cfg(windows)]
fn native_backend<R: Runtime>(app: &tauri::AppHandle<R>, log: SharedLog) -> Arc<dyn StoreBackend> {
    Arc::new(windows_store::WindowsStore::new(app.clone(), log))
}

/// No package exists off Windows, so no build gets here; it answers as a Store
/// that cannot be reached.
#[cfg(not(windows))]
fn native_backend<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    _log: SharedLog,
) -> Arc<dyn StoreBackend> {
    struct NoCancel;
    impl QueryHandle for NoCancel {
        fn cancel(&self) -> Result<(), String> {
            Ok(())
        }
    }
    struct NoStore;
    impl StoreBackend for NoStore {
        fn start_query(&self, events: Events) -> Box<dyn QueryHandle> {
            std::thread::spawn(move || {
                events(QueryEvent::Finished(QueryOutcome::ContextFailed(
                    "no Store".into(),
                )));
            });
            Box::new(NoCancel)
        }
    }
    Arc::new(NoStore)
}

struct SystemOpener;

impl Opener for SystemOpener {
    #[cfg(windows)]
    fn open(&self, uri: &str) -> Result<(), String> {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let file = HSTRING::from(uri);
        let operation = HSTRING::from("open");
        // SAFETY: both strings outlive the call; no window, parameters or
        // directory are passed.
        let instance = unsafe { ShellExecuteW(None, &operation, &file, None, None, SW_SHOWNORMAL) };
        // ShellExecuteW answers a value above 32 on success.
        let code = instance.0 as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW {code}"))
        }
    }

    #[cfg(not(windows))]
    fn open(&self, _uri: &str) -> Result<(), String> {
        Err("no Microsoft Store on this system".to_string())
    }
}

#[cfg(windows)]
mod windows_store {
    use super::{
        read_answer, EntryReads, Events, QueryEvent, QueryHandle, QueryOutcome, SharedLog, Signal,
        StoreBackend, Version4,
    };
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use tauri::{Manager, Runtime};
    use windows::core::Interface;
    use windows::Services::Store::StoreContext;
    use windows::Win32::UI::Shell::IInitializeWithWindow;

    fn code(error: &windows::core::Error) -> String {
        format!("0x{:08X}", error.code().0 as u32)
    }

    /// The real Store. The context is created, and every StoreContext call is
    /// made, on the main thread (D1): the query, the signal and Cancel are
    /// posted there; only the answer's list is read where its completion
    /// arrives. Each native call is logged before and after it (D12). A
    /// query's events go, in order, to one thread of its own, so never inside
    /// a caller holding the core's lock; each instant is taken where its event
    /// happened.
    pub(super) struct WindowsStore<R: Runtime> {
        app: tauri::AppHandle<R>,
        context: Arc<Mutex<Option<StoreContext>>>,
        log: SharedLog,
    }

    impl<R: Runtime> WindowsStore<R> {
        pub(super) fn new(app: tauri::AppHandle<R>, log: SharedLog) -> Self {
            WindowsStore {
                app,
                context: Arc::new(Mutex::new(None)),
                log,
            }
        }
    }

    type CancelCall = Box<dyn Fn() -> windows::core::Result<()> + Send>;

    /// Hands a query's events on, in the order they were sent.
    fn forward(events: Events) -> Sender<QueryEvent> {
        let (sender, receiver) = channel();
        std::thread::spawn(move || {
            for event in receiver {
                events(event);
            }
        });
        sender
    }

    fn finish(sender: &Sender<QueryEvent>, outcome: QueryOutcome) {
        let _ = sender.send(QueryEvent::Finished(outcome));
    }

    /// One query's Cancel: called once, on the main thread, when both the
    /// operation and the request exist.
    #[derive(Default)]
    struct Slot {
        cancel: Option<CancelCall>,
        requested: bool,
        called: bool,
    }

    impl Slot {
        fn cancel_if_due(&mut self, log: &SharedLog) {
            if !self.requested || self.called {
                return;
            }
            let Some(cancel) = &self.cancel else { return };
            self.called = true;
            log("store call: Cancel");
            match cancel() {
                Ok(()) => log("store result: Cancel ok"),
                Err(error) => log(&format!("store result: Cancel {}", code(&error))),
            }
        }
    }

    struct Handle<R: Runtime> {
        app: tauri::AppHandle<R>,
        slot: Arc<Mutex<Slot>>,
        log: SharedLog,
    }

    impl<R: Runtime> QueryHandle for Handle<R> {
        fn cancel(&self) -> Result<(), String> {
            self.slot
                .lock()
                .expect("store query slot lock poisoned")
                .requested = true;
            let slot = self.slot.clone();
            let log = self.log.clone();
            self.app
                .run_on_main_thread(move || {
                    slot.lock()
                        .expect("store query slot lock poisoned")
                        .cancel_if_due(&log);
                })
                .map_err(|error| error.to_string())
        }
    }

    /// The context, created and tied to the main window the first time; on
    /// the main thread.
    fn context<R: Runtime>(
        app: &tauri::AppHandle<R>,
        slot: &Mutex<Option<StoreContext>>,
        log: &SharedLog,
    ) -> Result<StoreContext, String> {
        let mut slot = slot.lock().expect("store context lock poisoned");
        if let Some(context) = slot.as_ref() {
            return Ok(context.clone());
        }
        let window = app
            .get_webview_window("main")
            .ok_or("the main window is not there")?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        log("store call: GetDefault");
        let context = StoreContext::GetDefault().map_err(|error| {
            log(&format!("store result: GetDefault {}", code(&error)));
            format!("GetDefault {}", code(&error))
        })?;
        log("store result: GetDefault ok");
        log("store call: Initialize");
        let initialized = context
            .cast::<IInitializeWithWindow>()
            // SAFETY: `hwnd` is the main window's, alive on this, its own thread.
            .and_then(|initialize| unsafe {
                initialize.Initialize(windows::Win32::Foundation::HWND(hwnd.0))
            });
        if let Err(error) = initialized {
            log(&format!("store result: Initialize {}", code(&error)));
            return Err(format!("Initialize {}", code(&error)));
        }
        log("store result: Initialize ok");
        *slot = Some(context.clone());
        Ok(context)
    }

    /// `CanSilentlyDownloadStorePackageUpdates`, on the main thread.
    fn signal(context: &StoreContext, log: &SharedLog) -> Signal {
        log("store call: CanSilentlyDownloadStorePackageUpdates");
        match context.CanSilentlyDownloadStorePackageUpdates() {
            Ok(true) => {
                log("store result: CanSilentlyDownloadStorePackageUpdates true");
                Signal::True
            }
            Ok(false) => {
                log("store result: CanSilentlyDownloadStorePackageUpdates false");
                Signal::False
            }
            Err(error) => {
                log(&format!(
                    "store result: CanSilentlyDownloadStorePackageUpdates {}",
                    code(&error)
                ));
                Signal::Error
            }
        }
    }

    impl<R: Runtime> StoreBackend for WindowsStore<R> {
        fn start_query(&self, events: Events) -> Box<dyn QueryHandle> {
            let slot = Arc::new(Mutex::new(Slot::default()));
            let sender = forward(events);
            let app = self.app.clone();
            let context_slot = self.context.clone();
            let log = self.log.clone();
            let query_slot = slot.clone();
            let on_main = sender.clone();
            let posted = self.app.run_on_main_thread(move || {
                let context = match context(&app, &context_slot, &log) {
                    Ok(context) => context,
                    Err(reason) => return finish(&on_main, QueryOutcome::ContextFailed(reason)),
                };
                log("store call: GetAppAndOptionalStorePackageUpdatesAsync");
                let operation = match context.GetAppAndOptionalStorePackageUpdatesAsync() {
                    Ok(operation) => operation,
                    Err(error) => {
                        let code = code(&error);
                        log(&format!(
                            "store result: GetAppAndOptionalStorePackageUpdatesAsync {code}"
                        ));
                        return finish(&on_main, QueryOutcome::Failed(code));
                    }
                };
                log("store result: GetAppAndOptionalStorePackageUpdatesAsync started");
                let _ = on_main.send(QueryEvent::Started(Instant::now()));
                {
                    let mut slot = query_slot.lock().expect("store query slot lock poisoned");
                    let to_cancel = operation.clone();
                    slot.cancel = Some(Box::new(move || to_cancel.Cancel()));
                    slot.cancel_if_due(&log);
                }
                let finished = on_main.clone();
                let completion_log = log.clone();
                let main = app.clone();
                let when = operation.when(move |answer| {
                    let _ = finished.send(QueryEvent::Answered(Instant::now()));
                    // The whole answer, or the first read that failed (D2).
                    let read = match answer {
                        Err(error) => Err(code(&error)),
                        Ok(list) => read_answer(list.Size().map_err(|error| code(&error)), |index| {
                            let update = list.GetAt(index).map_err(|error| code(&error))?;
                            let id = update
                                .Package()
                                .and_then(|package| package.Id())
                                .map_err(|error| code(&error))?;
                            Ok(EntryReads {
                                family: id
                                    .FamilyName()
                                    .map(|name| name.to_string())
                                    .map_err(|error| code(&error)),
                                full_name: id
                                    .FullName()
                                    .map(|name| name.to_string())
                                    .map_err(|error| code(&error)),
                                mandatory: update.Mandatory().map_err(|error| code(&error)),
                                version: id
                                    .Version()
                                    .map(|version| {
                                        Version4([
                                            version.Major,
                                            version.Minor,
                                            version.Build,
                                            version.Revision,
                                        ])
                                    })
                                    .map_err(|error| code(&error)),
                            })
                        }),
                    };
                    let entries = match read {
                        Err(code) => {
                            completion_log(&format!(
                                "store result: GetAppAndOptionalStorePackageUpdatesAsync {code}"
                            ));
                            return finish(&finished, QueryOutcome::Failed(code));
                        }
                        Ok(entries) => entries,
                    };
                    completion_log(&format!(
                        "store result: GetAppAndOptionalStorePackageUpdatesAsync {} entries",
                        entries.len()
                    ));
                    if !entries
                        .iter()
                        .any(|entry| entry.family == super::STORE_FAMILY)
                    {
                        let signal = Signal::True;
                        return finish(&finished, QueryOutcome::Answer { entries, signal });
                    }
                    let kept = entries.clone();
                    let on_signal = finished.clone();
                    let signal_log = completion_log.clone();
                    let posted = main.run_on_main_thread(move || {
                        let signal = signal(&context, &signal_log);
                        finish(&on_signal, QueryOutcome::Answer { entries, signal });
                    });
                    if let Err(error) = posted {
                        completion_log(&format!(
                            "store result: CanSilentlyDownloadStorePackageUpdates not called ({error})"
                        ));
                        let signal = Signal::Error;
                        finish(&finished, QueryOutcome::Answer { entries: kept, signal });
                    }
                });
                if let Err(error) = when {
                    // The query runs on unobserved: the core times it out and
                    // waits for the rest of this run (D2).
                    log(&format!("store result: Completed {}", code(&error)));
                }
            });
            if let Err(error) = posted {
                finish(&sender, QueryOutcome::Failed(error.to_string()));
            }
            Box::new(Handle {
                app: self.app.clone(),
                slot,
                log: self.log.clone(),
            })
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(
    clippy::disallowed_methods,
    reason = "the tests build their fixtures by pathname, in temporary directories of their own"
)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // ── Fixtures ──

    struct TestClock {
        base: Instant,
        mono: Mutex<Duration>,
        civil: Mutex<u64>,
    }

    impl TestClock {
        fn new() -> Arc<Self> {
            Arc::new(TestClock {
                base: Instant::now(),
                mono: Mutex::new(Duration::ZERO),
                civil: Mutex::new(1_795_000_000),
            })
        }
        /// Both clocks move by `seconds`.
        fn advance(&self, seconds: u64) {
            *self.mono.lock().unwrap() += Duration::from_secs(seconds);
            *self.civil.lock().unwrap() += seconds;
        }
        fn jump_civil(&self, seconds: u64) {
            *self.civil.lock().unwrap() += seconds;
        }
        fn jump_mono(&self, seconds: u64) {
            *self.mono.lock().unwrap() += Duration::from_secs(seconds);
        }
    }

    impl Clock for TestClock {
        fn civil(&self) -> u64 {
            *self.civil.lock().unwrap()
        }
        fn mono(&self) -> Instant {
            self.base + *self.mono.lock().unwrap()
        }
    }

    /// One query the recording store holds for the test to drive.
    struct Held {
        events: Events,
        created: Instant,
        started: bool,
    }

    /// Records each query and holds its events for the test to send; also
    /// counts cancels. Its interface has the query and Cancel only (R-3).
    #[derive(Default)]
    struct RecordingStore {
        held: Mutex<Vec<Held>>,
        queries: AtomicU64,
        cancels: Arc<AtomicU64>,
        cancel_fails: bool,
        clock: Option<Arc<TestClock>>,
        /// The states published, as the fixture records them.
        published: Arc<Mutex<Vec<UpdateState>>>,
        /// What the last published state said when each Cancel came.
        cancel_saw: Arc<Mutex<Vec<Option<Checking>>>>,
    }

    struct RecordingHandle {
        cancels: Arc<AtomicU64>,
        fails: bool,
        published: Arc<Mutex<Vec<UpdateState>>>,
        cancel_saw: Arc<Mutex<Vec<Option<Checking>>>>,
    }

    impl QueryHandle for RecordingHandle {
        fn cancel(&self) -> Result<(), String> {
            let last = self
                .published
                .lock()
                .unwrap()
                .last()
                .map(|state| state.checking);
            self.cancel_saw.lock().unwrap().push(last);
            self.cancels.fetch_add(1, Ordering::SeqCst);
            if self.fails {
                Err("0x80004005".into())
            } else {
                Ok(())
            }
        }
    }

    impl StoreBackend for RecordingStore {
        fn start_query(&self, events: Events) -> Box<dyn QueryHandle> {
            self.queries.fetch_add(1, Ordering::SeqCst);
            self.held.lock().unwrap().push(Held {
                events,
                created: self.now(),
                started: false,
            });
            Box::new(RecordingHandle {
                cancels: self.cancels.clone(),
                fails: self.cancel_fails,
                published: self.published.clone(),
                cancel_saw: self.cancel_saw.clone(),
            })
        }
    }

    impl RecordingStore {
        fn now(&self) -> Instant {
            self.clock.as_ref().expect("the fixture's clock").mono()
        }
        fn queries(&self) -> u64 {
            self.queries.load(Ordering::SeqCst)
        }
        /// The oldest query's native start, now.
        fn begin(&self) {
            let events = {
                let mut held = self.held.lock().unwrap();
                let query = held.first_mut().expect("a query");
                query.started = true;
                query.events.clone()
            };
            events(QueryEvent::Started(self.now()));
        }
        /// The oldest query's answer arrives, now; its end comes later.
        fn answered(&self) {
            let events = self.held.lock().unwrap()[0].events.clone();
            events(QueryEvent::Answered(self.now()));
        }
        /// The oldest query's end alone.
        fn finish(&self, outcome: QueryOutcome) {
            let query = self.held.lock().unwrap().remove(0);
            (query.events)(QueryEvent::Finished(outcome));
        }
        /// The oldest query's answer, now, and its end; a start not yet
        /// reported is reported first, as of when the query was asked for.
        fn answer(&self, outcome: QueryOutcome) {
            let query = self.held.lock().unwrap().remove(0);
            let context_failed = matches!(outcome, QueryOutcome::ContextFailed(_));
            if !query.started && !context_failed {
                (query.events)(QueryEvent::Started(query.created));
            }
            if !context_failed {
                (query.events)(QueryEvent::Answered(self.now()));
            }
            (query.events)(QueryEvent::Finished(outcome));
        }
    }

    #[derive(Default)]
    struct RecordingOpener {
        opened: Mutex<Vec<String>>,
        refuse: bool,
    }

    impl Opener for RecordingOpener {
        fn open(&self, uri: &str) -> Result<(), String> {
            self.opened.lock().unwrap().push(uri.to_string());
            if self.refuse {
                Err("ShellExecuteW 2".into())
            } else {
                Ok(())
            }
        }
    }

    struct Fixture {
        _dir: tempfile_lite::TempDir,
        path: PathBuf,
        clock: Arc<TestClock>,
        store: Arc<RecordingStore>,
        opener: Arc<RecordingOpener>,
        emitted: Arc<Mutex<Vec<UpdateState>>>,
        logged: Arc<Mutex<Vec<String>>>,
    }

    /// A temporary directory removed on drop, without a dependency.
    mod tempfile_lite {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        pub(super) struct TempDir(PathBuf);
        impl TempDir {
            pub(super) fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "lasterm-store-updates-{}-{}",
                    std::process::id(),
                    COUNTER.fetch_add(1, Ordering::SeqCst)
                ));
                std::fs::create_dir_all(&path).unwrap();
                TempDir(path)
            }
            pub(super) fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    const RUNNING: Version4 = Version4([0, 24, 0, 0]);
    const KEY_25: &str = "O2CSI.Lasterm_0.25.0.0_x64__sx7tynvv0nmw4";
    const KEY_26: &str = "O2CSI.Lasterm_0.26.0.0_x64__sx7tynvv0nmw4";

    impl Fixture {
        fn new() -> Self {
            Self::with(RecordingStore::default(), RecordingOpener::default())
        }

        fn with(store: RecordingStore, opener: RecordingOpener) -> Self {
            let dir = tempfile_lite::TempDir::new();
            let path = dir.path().join(UPDATES_FILE);
            let emitted = Arc::new(Mutex::new(Vec::new()));
            let clock = TestClock::new();
            let store = RecordingStore {
                published: emitted.clone(),
                clock: Some(clock.clone()),
                ..store
            };
            Fixture {
                _dir: dir,
                path,
                clock,
                store: Arc::new(store),
                opener: Arc::new(opener),
                emitted,
                logged: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn write(&self, contents: &str) {
            std::fs::write(&self.path, contents).unwrap();
        }

        fn read(&self) -> String {
            std::fs::read_to_string(&self.path).unwrap_or_default()
        }

        fn parts(&self) -> CoreParts {
            let emitted = self.emitted.clone();
            let logged = self.logged.clone();
            CoreParts {
                running: RUNNING,
                backend: self.store.clone(),
                opener: self.opener.clone(),
                clock: self.clock.clone(),
                path: self.path.clone(),
                emit: Box::new(move |state| emitted.lock().unwrap().push(state.clone())),
                log: Box::new(move |line| logged.lock().unwrap().push(line.to_string())),
            }
        }

        fn core(&self) -> Arc<Mutex<Core>> {
            Core::create(self.parts())
        }

        fn last_state(&self) -> UpdateState {
            self.emitted
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("a state was emitted")
        }
    }

    fn offer(key: &str, version: Option<&str>, mandatory: bool) -> Entry {
        Entry {
            family: STORE_FAMILY.into(),
            full_name: key.into(),
            mandatory,
            version: version.and_then(Version4::parse),
        }
    }

    fn answer(entries: Vec<Entry>, signal: Signal) -> QueryOutcome {
        QueryOutcome::Answer { entries, signal }
    }

    /// Runs one check through `check_now` and answers it.
    fn check(fixture: &Fixture, core: &Arc<Mutex<Core>>, outcome: QueryOutcome) {
        lock(core).check_now();
        fixture.store.answer(outcome);
    }

    fn state(core: &Arc<Mutex<Core>>) -> UpdateState {
        lock(core).state()
    }

    fn poll_for(fixture: &Fixture, core: &Arc<Mutex<Core>>, seconds: u64) {
        for _ in 0..seconds {
            fixture.clock.advance(1);
            lock(core).poll();
        }
    }

    // ── AC-1 ──

    #[test]
    fn eligibility_requires_all_four() {
        let store = PackageFacts {
            family: STORE_FAMILY.into(),
            store_signed: true,
            version: RUNNING,
        };
        assert_eq!(eligibility(true, Some(store.clone())), Ok(store.clone()));
        assert_eq!(
            eligibility(false, Some(store.clone())),
            Err(Ineligible::Channel)
        );
        assert_eq!(eligibility(true, None), Err(Ineligible::Package));
        let other = PackageFacts {
            family: "O2CSI.Lasterm_other".into(),
            ..store.clone()
        };
        assert_eq!(eligibility(true, Some(other)), Err(Ineligible::Family));
        let developer = PackageFacts {
            store_signed: false,
            ..store
        };
        assert_eq!(
            eligibility(true, Some(developer)),
            Err(Ineligible::Signature)
        );
        assert_eq!(Ineligible::Signature.as_str(), "signature");
    }

    // ── AC-4, R-2 ──

    #[test]
    fn mode_file_cases() {
        let missing = Fixture::new();
        assert_eq!(state(&missing.core()).mode, Mode::Ask);

        let auto = Fixture::new();
        auto.write(r#"{"mode":"auto"}"#);
        let core = auto.core();
        assert_eq!(state(&core).mode, Mode::Auto);
        assert_eq!(state(&core).load_error, None);

        for invalid in [
            "{not json",
            r#"{"mode":"sometimes"}"#,
            r#"{"snoozedKey":"x"}"#,
        ] {
            let fixture = Fixture::new();
            fixture.write(invalid);
            let core = fixture.core();
            assert_eq!(state(&core).mode, Mode::Ask, "{invalid}");
            assert_eq!(
                state(&core).load_error.as_deref(),
                Some(LOAD_ERROR),
                "{invalid}"
            );
        }

        let bad_field = Fixture::new();
        bad_field.write(r#"{"mode":"off","lastRunVersion":12,"other":true}"#);
        let core = bad_field.core();
        assert_eq!(state(&core).mode, Mode::Off);
        assert_eq!(state(&core).load_error, None);
        // The version, of the wrong form, counted as absent: the running one is recorded.
        assert!(bad_field.read().contains(r#""lastRunVersion":"0.24.0.0""#));
    }

    #[test]
    fn a_failed_replace_keeps_the_previous_file_whole() {
        let fixture = Fixture::new();
        fixture.write(r#"{"mode":"ask","lastRunVersion":"0.24.0.0"}"#);
        let core = Core::create_with_replace(
            fixture.parts(),
            Box::new(|_, _| Err(std::io::Error::other("injected"))),
        );
        let error = lock(&core).set_mode("off").unwrap_err();
        assert!(
            error.contains("failed to replace update preference"),
            "{error}"
        );
        assert_eq!(state(&core).mode, Mode::Ask);
        assert_eq!(
            fixture.read(),
            r#"{"mode":"ask","lastRunVersion":"0.24.0.0"}"#
        );
    }

    #[test]
    fn invalid_bytes_are_rewritten_only_by_a_mode_change() {
        let fixture = Fixture::new();
        fixture.write("\u{0}\u{1}garbage");
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        // Held in memory only, and said so: the file stays as it is.
        assert_eq!(lock(&core).snooze(KEY_25), Ok(false));
        assert_eq!(fixture.read(), "\u{0}\u{1}garbage");
        // Always update leaves it to the Updates setting.
        assert_eq!(
            lock(&core).choose_always_update(KEY_25.into()),
            Err(UNLOADED_CHOICE.into())
        );
        assert_eq!(fixture.read(), "\u{0}\u{1}garbage");
        assert_eq!(state(&core).mode, Mode::Ask);
        lock(&core).set_mode("off").unwrap();
        assert!(fixture.read().contains(r#""mode":"off""#));
    }

    #[test]
    fn a_failed_snooze_write_holds_in_memory() {
        let fixture = Fixture::new();
        fixture.write(r#"{"mode":"ask","lastRunVersion":"0.24.0.0"}"#);
        let core = Core::create_with_replace(
            fixture.parts(),
            Box::new(|_, _| Err(std::io::Error::other("injected"))),
        );
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        assert_eq!(lock(&core).snooze(KEY_25), Ok(false));
        let state = state(&core);
        assert!(state.save_error.is_some());
        assert!(!state.wants_dialog);
    }

    #[test]
    fn set_mode_refuses_unknown() {
        let fixture = Fixture::new();
        fixture.write(r#"{"mode":"auto","lastRunVersion":"0.24.0.0"}"#);
        let core = fixture.core();
        assert_eq!(lock(&core).set_mode("sometimes"), Err(UNKNOWN_MODE.into()));
        assert_eq!(
            fixture.read(),
            r#"{"mode":"auto","lastRunVersion":"0.24.0.0"}"#
        );
    }

    // ── AC-5 ──

    #[test]
    fn scheduler_calls_checks() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).window_shown();
        poll_for(&fixture, &core, 59);
        assert_eq!(fixture.store.queries(), 0);
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 1, "60 s after the window shows");
        fixture.store.answer(answer(vec![], Signal::True));
        assert!(state(&core).last_checked_at.is_some());

        // A day of civil time on monotonic 1 h: due at the next tick.
        fixture.clock.jump_civil(DAY);
        fixture.clock.jump_mono(TICK.as_secs());
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 2, "civil 24 h");
        fixture.store.answer(answer(vec![], Signal::True));

        // Only 1 h of civil time later, nothing even across a tick.
        fixture.clock.advance(TICK.as_secs());
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 2);

        // A 30-hour sleep: the first tick after it checks.
        fixture.clock.advance(30 * 3600);
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 3, "after a sleep");
        fixture.store.answer(answer(vec![], Signal::True));

        // Off: no scheduled check; the button still checks.
        lock(&core).set_mode("off").unwrap();
        fixture.clock.advance(2 * DAY);
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 3);
        lock(&core).check_now();
        assert_eq!(fixture.store.queries(), 4, "the button in off");
        fixture.store.answer(answer(vec![], Signal::True));

        // Leaving off: due 60 s later.
        lock(&core).set_mode("ask").unwrap();
        poll_for(&fixture, &core, 59);
        assert_eq!(fixture.store.queries(), 4);
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 5, "leaving off");

        // A check during a check joins it.
        lock(&core).check_now();
        assert_eq!(fixture.store.queries(), 5, "joined");
    }

    // ── AC-6 ──

    #[test]
    fn offers() {
        let fixture = Fixture::new();
        let core = fixture.core();
        let foreign = Entry {
            family: "Other.Optional_x".into(),
            ..offer("Other.Optional_1.0.0.0_x64__x", Some("1.0.0.0"), true)
        };
        check(&fixture, &core, answer(vec![foreign.clone()], Signal::True));
        assert!(state(&core).offer.is_none(), "another family is ignored");

        check(
            &fixture,
            &core,
            answer(
                vec![
                    foreign,
                    offer(KEY_25, Some("0.25.0.0"), false),
                    offer(KEY_26, Some("0.26.0.0"), true),
                ],
                Signal::True,
            ),
        );
        let seen = state(&core).offer.unwrap();
        assert_eq!(seen.key, KEY_25);
        assert_eq!(seen.version.as_deref(), Some("0.25.0"));
        assert!(seen.mandatory, "any kept entry");

        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.24.0.0"), false)], Signal::True),
        );
        let equal = state(&core).offer.unwrap();
        assert_eq!(equal.version, None, "equal: kept without a number");

        assert!(Version4::parse("0.10.0.0") > Version4::parse("0.9.0.0"));
        let numeric = Fixture::new();
        let core = Core::create(CoreParts {
            running: Version4([0, 10, 0, 0]),
            ..numeric.parts()
        });
        check(
            &numeric,
            &core,
            answer(vec![offer(KEY_25, Some("0.9.0.0"), false)], Signal::True),
        );
        assert_eq!(state(&core).offer.unwrap().version, None);

        // A failed read keeps the previous offer and its date.
        let fixture = Fixture::new();
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        let before = state(&core);
        check(&fixture, &core, QueryOutcome::Failed("0x80070057".into()));
        let after = state(&core);
        assert_eq!(after.offer, before.offer);
        assert_eq!(after.last_checked_at, before.last_checked_at);
        assert!(after.check_error.unwrap().contains("0x80070057"));
    }

    #[test]
    fn version_parsing() {
        assert_eq!(Version4::parse("0.24.0.0"), Some(RUNNING));
        assert_eq!(Version4::parse("0.24.0"), None);
        assert_eq!(Version4::parse("0.24.0.x"), None);
        assert_eq!(Version4::parse("0.24..0"), None);
        assert_eq!(RUNNING.three(), "0.24.0");
    }

    #[test]
    fn iso_round_trips() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_795_000_000), "2026-11-18T11:06:40Z");
        assert_eq!(parse_iso("2026-11-18T11:06:40Z"), Some(1_795_000_000));
        assert_eq!(parse_iso("2026-02-30T00:00:00Z"), None);
        assert_eq!(parse_iso("2026-11-18 11:06:40Z"), None);
        // D3's ISO 8601: a fraction of a second, an offset, both.
        assert_eq!(parse_iso("2026-11-18T11:06:40.250Z"), Some(1_795_000_000));
        assert_eq!(parse_iso("2026-11-18T12:06:40+01:00"), Some(1_795_000_000));
        assert_eq!(parse_iso("2026-11-18T06:36:40-04:30"), Some(1_795_000_000));
        assert_eq!(
            parse_iso("2026-11-18T12:06:40.9+01:00"),
            Some(1_795_000_000)
        );
        for invalid in [
            "2026-11-18T11:06:40",
            "2026-11-18T11:06:40.Z",
            "2026-11-18T11:06:40+0100",
            "2026-11-18T11:06:40+24:00",
            "2026-11-18T11:06:40Zx",
            "1970-01-01T00:00:00+01:00",
        ] {
            assert_eq!(parse_iso(invalid), None, "{invalid}");
        }
    }

    // ── AC-7 ──

    #[test]
    fn check_timeout() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).check_now();
        fixture.store.begin();
        // Civil time alone does not time a query out.
        fixture.clock.jump_civil(3600);
        lock(&core).poll();
        assert_eq!(state(&core).checking, Checking::Running);
        poll_for(&fixture, &core, 59);
        assert_eq!(state(&core).checking, Checking::Running, "59 s");
        assert_eq!(state(&core).check_error, None);
        poll_for(&fixture, &core, 1);
        let timed_out = state(&core);
        assert_eq!(timed_out.checking, Checking::Waiting);
        assert_eq!(timed_out.check_error.as_deref(), Some(NO_ANSWER));
        assert_eq!(fixture.store.cancels.load(Ordering::SeqCst), 1);
        // Reported first, then cancelled.
        assert_eq!(
            *fixture.store.cancel_saw.lock().unwrap(),
            vec![Some(Checking::Waiting)]
        );
        // Nothing new while it is out.
        lock(&core).check_now();
        assert_eq!(fixture.store.queries(), 1);
        // Its late answer is ignored, and frees the lane.
        fixture.store.answer(answer(
            vec![offer(KEY_25, Some("0.25.0.0"), false)],
            Signal::True,
        ));
        assert!(state(&core).offer.is_none());
        assert_eq!(state(&core).last_checked_at, None);
        assert_eq!(state(&core).checking, Checking::Idle);
        lock(&core).check_now();
        assert_eq!(fixture.store.queries(), 2);

        // A Cancel that fails is logged; still waiting.
        let failing = Fixture::with(
            RecordingStore {
                cancel_fails: true,
                ..RecordingStore::default()
            },
            RecordingOpener::default(),
        );
        let core = failing.core();
        lock(&core).check_now();
        failing.store.begin();
        poll_for(&failing, &core, 60);
        assert_eq!(state(&core).checking, Checking::Waiting);
        assert!(failing
            .logged
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("store result: Cancel failed")));

        // A user check at T+59 s satisfies the check due at T+60 s.
        let joined = Fixture::new();
        let core = joined.core();
        lock(&core).window_shown();
        poll_for(&joined, &core, 59);
        lock(&core).check_now();
        poll_for(&joined, &core, 1);
        assert_eq!(joined.store.queries(), 1);
        joined.store.answer(answer(vec![], Signal::True));
        poll_for(&joined, &core, 1);
        assert_eq!(joined.store.queries(), 1, "none at the next tick");
    }

    // ── AC-12, AC-11 ──

    #[test]
    fn snooze_cases() {
        let fixture = Fixture::new();
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert!(state(&core).wants_dialog);
        let before = fixture.read();
        assert_eq!(lock(&core).snooze(KEY_26), Err(STALE_OFFER.into()));
        assert_eq!(fixture.read(), before, "a stale key stores nothing");
        assert!(state(&core).wants_dialog);
        fixture.clock.advance(3600);
        assert_eq!(
            lock(&core).snooze(KEY_25),
            Ok(true),
            "a mandatory offer snoozes as any"
        );
        assert!(!state(&core).wants_dialog);
        assert!(fixture.read().contains(KEY_25));

        // After a restart, still snoozed.
        let restarted = fixture.core();
        check(
            &fixture,
            &restarted,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert!(!state(&restarted).wants_dialog);

        // The daily check at T+24 h answering the same offer: still snoozed.
        fixture.clock.advance(23 * 3600);
        check(
            &fixture,
            &restarted,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert!(!state(&restarted).wants_dialog);
        // At T+25 h, the first tick: wanted, with no new check.
        let queries = fixture.store.queries();
        fixture.clock.advance(3600);
        lock(&restarted).poll();
        assert!(fixture.last_state().wants_dialog);
        assert_eq!(fixture.store.queries(), queries);

        // Another key shows at once.
        lock(&restarted).snooze(KEY_25).unwrap();
        check(
            &fixture,
            &restarted,
            answer(vec![offer(KEY_26, Some("0.26.0.0"), false)], Signal::True),
        );
        assert!(state(&restarted).wants_dialog);

        // A result after expiry and before the tick: wanted at that result.
        let between = Fixture::new();
        let core = between.core();
        check(
            &between,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        lock(&core).snooze(KEY_25).unwrap();
        between.clock.jump_civil(DAY + 1);
        check(
            &between,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        assert!(between.last_state().wants_dialog);

        // In auto with the signal true, an expired snooze wants nothing.
        let auto = Fixture::new();
        auto.write(r#"{"mode":"auto","lastRunVersion":"0.24.0.0"}"#);
        let core = auto.core();
        check(
            &auto,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        lock(&core).snooze(KEY_25).unwrap();
        auto.clock.advance(DAY + TICK.as_secs());
        lock(&core).poll();
        assert!(!state(&core).wants_dialog);
    }

    // ── AC-13 ──

    fn kinds(state: &UpdateState) -> Vec<NoticeKind> {
        state.notices.iter().map(|notice| notice.kind).collect()
    }

    #[test]
    fn auto_mode_cases() {
        let fixture = Fixture::new();
        fixture.write(r#"{"mode":"auto","lastRunVersion":"0.24.0.0"}"#);
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        let quiet = state(&core);
        assert!(!quiet.wants_dialog);
        assert!(quiet.notices.is_empty());
        assert!(
            fixture.read().contains("pendingSince"),
            "a new key sets pendingSince"
        );

        // Signal false or error: the fallback dialog.
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::False),
        );
        assert!(state(&core).wants_dialog);
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::Error),
        );
        assert!(state(&core).wants_dialog);

        // Mandatory: its notice; 6 days: no waiting; 7 days: waiting.
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert_eq!(kinds(&state(&core)), vec![NoticeKind::Mandatory]);
        fixture.clock.advance(6 * DAY);
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert_eq!(kinds(&state(&core)), vec![NoticeKind::Mandatory]);
        fixture.clock.advance(DAY);
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert_eq!(
            kinds(&state(&core)),
            vec![NoticeKind::Mandatory, NoticeKind::Waiting]
        );

        // The mark gone: mandatory removed. Signal error: both removed.
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        assert_eq!(kinds(&state(&core)), vec![NoticeKind::Waiting]);
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::False),
        );
        assert!(state(&core).notices.is_empty(), "signal false");
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert_eq!(
            kinds(&state(&core)),
            vec![NoticeKind::Mandatory, NoticeKind::Waiting]
        );
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::Error),
        );
        assert!(state(&core).notices.is_empty(), "signal error");

        // Acknowledged: not again within 24 h, across a restart; then again.
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        let mandatory = state(&core).notices[0].id;
        lock(&core).acknowledge(mandatory);
        let restarted = fixture.core();
        check(
            &fixture,
            &restarted,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert!(!kinds(&state(&restarted)).contains(&NoticeKind::Mandatory));
        fixture.clock.advance(DAY);
        check(
            &fixture,
            &restarted,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert!(kinds(&state(&restarted)).contains(&NoticeKind::Mandatory));

        // Created, not acknowledged, restart: derived again by the next check.
        let again = fixture.core();
        check(
            &fixture,
            &again,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert!(kinds(&state(&again)).contains(&NoticeKind::Mandatory));

        // A new key: pendingSince reset, old notices gone.
        check(
            &fixture,
            &again,
            answer(vec![offer(KEY_26, Some("0.26.0.0"), false)], Signal::True),
        );
        assert!(state(&again).notices.is_empty());
        assert!(fixture.read().contains(KEY_26));
        // An acknowledgement holds for its key: another mandatory key shows at once.
        check(
            &fixture,
            &again,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        let id = state(&again).notices[0].id;
        lock(&again).acknowledge(id);
        check(
            &fixture,
            &again,
            answer(vec![offer(KEY_26, Some("0.26.0.0"), true)], Signal::True),
        );
        assert_eq!(kinds(&state(&again)), vec![NoticeKind::Mandatory]);

        // Both conditions on one check: both notices.
        let both = Fixture::new();
        let week_ago = iso(both.clock.civil() - WEEK - 60);
        both.write(&format!(
            r#"{{"mode":"auto","lastRunVersion":"0.24.0.0","pendingSince":{{"key":"{KEY_25}","at":"{week_ago}"}}}}"#
        ));
        let core = both.core();
        check(
            &both,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert_eq!(
            kinds(&state(&core)),
            vec![NoticeKind::Mandatory, NoticeKind::Waiting]
        );
        // A successful answer with no offer: both notices, the offer and
        // pendingSince go.
        check(&both, &core, answer(vec![], Signal::True));
        assert!(state(&core).notices.is_empty());
        assert!(state(&core).offer.is_none());
        assert!(!both.read().contains("pendingSince"));

        // Off clears pendingSince, the snooze and these notices; keeps updated.
        let off = Fixture::new();
        off.write(r#"{"mode":"auto","lastRunVersion":"0.23.0.0"}"#);
        let core = off.core();
        check(
            &off,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::True),
        );
        assert_eq!(
            kinds(&state(&core)),
            vec![NoticeKind::Updated, NoticeKind::Mandatory]
        );
        lock(&core).set_mode("ask").unwrap();
        lock(&core).snooze(KEY_25).unwrap();
        assert!(off.read().contains("snoozedKey"));
        lock(&core).set_mode("auto").unwrap();
        lock(&core).set_mode("off").unwrap();
        assert_eq!(kinds(&state(&core)), vec![NoticeKind::Updated]);
        assert!(!off.read().contains("pendingSince"));
        assert!(!off.read().contains("snoozedKey"), "off clears the snooze");
        // A check completing in off: offer shown, nothing else.
        check(
            &off,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), true)], Signal::False),
        );
        let in_off = state(&core);
        assert!(in_off.offer.is_some());
        assert!(!in_off.wants_dialog);
        assert_eq!(kinds(&in_off), vec![NoticeKind::Updated]);
        assert!(!off.read().contains("pendingSince"));
        // Entering ask with an unsnoozed offer: wanted at once.
        lock(&core).set_mode("ask").unwrap();
        assert!(state(&core).wants_dialog);
        // Entering auto sets pendingSince; re-entering for the same offer keeps it.
        lock(&core).set_mode("auto").unwrap();
        let first = off.read();
        assert!(
            first
                .split("pendingSince")
                .nth(1)
                .is_some_and(|rest| rest.contains(KEY_25)),
            "{first}"
        );
        off.clock.advance(3600);
        lock(&core).set_mode("ask").unwrap();
        lock(&core).set_mode("auto").unwrap();
        let pending = |text: &str| text.split("pendingSince").nth(1).map(str::to_string);
        assert_eq!(pending(&first), pending(&off.read()));
    }

    // ── AC-9 (native side): Always update in one step ──

    #[test]
    fn always_update_writes_mode_and_snooze_at_once() {
        let fixture = Fixture::new();
        fixture.write(r#"{"mode":"ask","lastRunVersion":"0.24.0.0"}"#);
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::False),
        );
        let before = fixture.emitted.lock().unwrap().len();
        lock(&core).choose_always_update(KEY_25.into()).unwrap();
        let emitted = fixture.emitted.lock().unwrap();
        assert_eq!(emitted.len(), before + 1, "one state published");
        let after = emitted.last().unwrap();
        assert_eq!(after.mode, Mode::Auto);
        assert!(
            !after.wants_dialog,
            "signal false, but snoozed in the same step"
        );
        assert!(fixture.read().contains(r#""mode":"auto""#));
        assert!(fixture.read().contains("snoozedKey"));
    }

    // ── AC-14 ──

    #[test]
    fn store_links() {
        let fixture = Fixture::new();
        let core = fixture.core();
        assert_eq!(open_page(&core), Ok(()));
        assert_eq!(open_updates(&core), Ok(()));
        assert_eq!(
            *fixture.opener.opened.lock().unwrap(),
            vec![
                "ms-windows-store://pdp/?ProductId=9P82QRJ6VDWL".to_string(),
                "ms-windows-store://downloadsandupdates".to_string()
            ]
        );
        let logged = fixture.logged.lock().unwrap().clone();
        assert!(logged.contains(&"store link: page accepted".to_string()));
        assert!(logged.contains(&"store link: updates accepted".to_string()));

        let refusing = Fixture::with(
            RecordingStore::default(),
            RecordingOpener {
                refuse: true,
                ..RecordingOpener::default()
            },
        );
        let core = refusing.core();
        assert_eq!(
            open_updates(&core),
            Err("The Microsoft Store could not be opened.".into())
        );
        assert!(refusing
            .logged
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("store link: updates refused")));
    }

    // ── AC-15 ──

    #[test]
    fn notices() {
        let fixture = Fixture::new();
        fixture.write(r#"{"mode":"ask","lastRunVersion":"0.23.0.0"}"#);
        let core = fixture.core();
        let updated = state(&core);
        assert_eq!(kinds(&updated), vec![NoticeKind::Updated]);
        assert_eq!(updated.notices[0].text, "Lasterm was updated to 0.24.0.");
        assert!(
            fixture.read().contains("0.23.0.0"),
            "not written before acknowledged"
        );

        // A restart before acknowledging: the notice again.
        let restarted = fixture.core();
        let id = state(&restarted).notices[0].id;
        // An unknown id changes nothing.
        lock(&restarted).acknowledge(id + 100);
        assert!(fixture.read().contains("0.23.0.0"));
        lock(&restarted).acknowledge(id);
        assert!(fixture.read().contains(r#""lastRunVersion":"0.24.0.0""#));
        assert!(state(&fixture.core()).notices.is_empty());

        // First start, equal, lower: none, the running version written.
        for recorded in [None, Some("0.24.0.0"), Some("0.25.0.0")] {
            let fixture = Fixture::new();
            if let Some(version) = recorded {
                fixture.write(&format!(r#"{{"mode":"off","lastRunVersion":"{version}"}}"#));
            }
            let core = fixture.core();
            assert!(state(&core).notices.is_empty(), "{recorded:?}");
            assert!(
                fixture.read().contains(r#""lastRunVersion":"0.24.0.0""#),
                "{recorded:?}"
            );
        }
    }

    // ── AC-16 ──

    #[test]
    fn scripted_backend_gate() {
        let (version, _) = ScriptedStore::parse(
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k","version":"0.25.0.0"}],"signal":"false"},{"noAnswer":true}]}"#,
        )
        .unwrap();
        assert_eq!(version, RUNNING);
        for invalid in [
            "{",
            r#"{"version":"0.24","checks":[{"noAnswer":true}]}"#,
            r#"{"version":"0.24.0.0","checks":[]}"#,
        ] {
            assert!(ScriptedStore::parse(invalid).is_err(), "{invalid}");
        }
        // A release build never reads the script: eligibility() decides on
        // the package alone, and install() only consults the script when the
        // channel is dev.
        assert_eq!(eligibility(true, None), Err(Ineligible::Package));
    }

    #[test]
    fn the_scripted_store_answers_in_order_and_repeats_the_last() {
        let (_, store) = ScriptedStore::parse(
            r#"{"version":"0.24.0.0","checks":[{"error":"0x80072EE7"},{"offers":[{"key":"k"}]}]}"#,
        )
        .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        for _ in 0..3 {
            let sender = Mutex::new(sender.clone());
            store.start_query(Arc::new(move |event| {
                if let QueryEvent::Finished(outcome) = event {
                    sender.lock().unwrap().send(outcome).unwrap();
                }
            }));
        }
        let mut outcomes: Vec<QueryOutcome> = (0..3).map(|_| receiver.recv().unwrap()).collect();
        outcomes.sort_by_key(|outcome| matches!(outcome, QueryOutcome::Answer { .. }));
        assert_eq!(outcomes[0], QueryOutcome::Failed("0x80072EE7".into()));
        assert!(
            matches!(&outcomes[1], QueryOutcome::Answer { entries, .. } if entries[0].full_name == "k")
        );
        assert!(matches!(&outcomes[2], QueryOutcome::Answer { .. }));

        // It records each call it stands in for, Cancel included (D1).
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let store = ScriptedStore {
            log: Some(Arc::new(move |line: &str| {
                seen.lock().unwrap().push(line.to_string())
            })),
            ..store
        };
        let handle = store.start_query(Arc::new(|_| {}));
        handle.cancel().unwrap();
        // A context failure starts no query: the scripted log says so.
        let (_, failing) = ScriptedStore::parse(
            r#"{"version":"0.24.0.0","checks":[{"contextError":"0x80004005"}]}"#,
        )
        .unwrap();
        let context_lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = context_lines.clone();
        let failing = ScriptedStore {
            log: Some(Arc::new(move |line: &str| {
                seen.lock().unwrap().push(line.to_string())
            })),
            ..failing
        };
        drop(failing.start_query(Arc::new(|_| {})));
        assert_eq!(
            *context_lines.lock().unwrap(),
            vec![
                "store call (scripted): GetDefault",
                "store result (scripted): GetDefault 0x80004005"
            ]
        );
        assert_eq!(
            *lines.lock().unwrap(),
            vec![
                "store call (scripted): GetAppAndOptionalStorePackageUpdatesAsync",
                "store call (scripted): CanSilentlyDownloadStorePackageUpdates",
                "store call (scripted): Cancel"
            ]
        );
    }

    // ── AC-17 ──

    #[test]
    fn context_failure() {
        let fixture = Fixture::new();
        let core = fixture.core();
        check(
            &fixture,
            &core,
            QueryOutcome::ContextFailed("GetDefault 0x80004005".into()),
        );
        let failed = state(&core);
        assert_eq!(failed.store_error.as_deref(), Some(STORE_UNAVAILABLE));
        assert!(failed.eligible);
        // Links still work.
        assert_eq!(open_page(&core), Ok(()));
        // Tried again at the next 15-minute tick; a success clears the error.
        poll_for(&fixture, &core, TICK.as_secs() - 1);
        assert_eq!(fixture.store.queries(), 1);
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 2);
        fixture.store.answer(answer(vec![], Signal::True));
        assert_eq!(state(&core).store_error, None);
    }

    // ── R-3 ──

    #[test]
    fn only_query_calls() {
        // The backend trait has `start_query` alone, and its handle `cancel`:
        // nothing a test or the core could call to download or install. Across
        // a run of every path above, the recording store sees queries only.
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).window_shown();
        poll_for(&fixture, &core, 60);
        fixture.store.answer(answer(
            vec![offer(KEY_25, Some("0.25.0.0"), true)],
            Signal::False,
        ));
        lock(&core).set_mode("auto").unwrap();
        lock(&core).snooze(KEY_25).unwrap();
        lock(&core).choose_always_update(KEY_25.into()).unwrap();
        fixture.clock.advance(DAY + TICK.as_secs());
        lock(&core).poll();
        // The first check and the daily one, and nothing else reached it.
        assert_eq!(fixture.store.queries(), 2);
    }

    // ── AC-1, AC-2, AC-16: which builds check ──

    fn chosen(
        release: bool,
        package: Option<PackageFacts>,
        script: Option<&str>,
        config: Result<PathBuf, String>,
    ) -> (Option<Chosen>, Vec<String>, bool) {
        let dir = tempfile_lite::TempDir::new();
        let script = script.map(|text| {
            let path = dir.path().join("script.json");
            std::fs::write(&path, text).unwrap();
            path.into_os_string()
        });
        let read = std::sync::atomic::AtomicBool::new(false);
        let lines = Mutex::new(Vec::new());
        let result = choose(
            release,
            &|| {
                read.store(true, Ordering::SeqCst);
                package.clone()
            },
            script,
            &|| config.clone(),
            &|line| lines.lock().unwrap().push(line.to_string()),
        );
        (
            result,
            lines.into_inner().unwrap(),
            read.load(Ordering::SeqCst),
        )
    }

    #[test]
    fn choose_decides_once_with_one_line() {
        let store = PackageFacts {
            family: STORE_FAMILY.into(),
            store_signed: true,
            version: Version4([0, 25, 0, 0]),
        };
        let dir = || Ok(PathBuf::from("config"));
        const SCRIPT: &str = r#"{"version":"0.24.0.0","checks":[{"noAnswer":true}]}"#;

        // A release build of the Store's package: native, the package's version.
        let (result, lines, _) = chosen(true, Some(store.clone()), None, dir());
        let result = result.expect("eligible");
        assert!(matches!(result.source, Source::Native));
        assert_eq!(result.running, Version4([0, 25, 0, 0]));
        assert_eq!(result.path, PathBuf::from("config").join(UPDATES_FILE));
        assert_eq!(lines, vec!["store updates: eligible"]);

        // A release build ignores a script, valid or not.
        let (result, lines, _) = chosen(true, Some(store.clone()), Some("{"), dir());
        assert!(matches!(
            result.map(|chosen| chosen.source),
            Some(Source::Native)
        ));
        assert_eq!(lines, vec!["store updates: eligible"]);
        let (result, lines, _) = chosen(true, None, Some(SCRIPT), dir());
        assert!(result.is_none());
        assert_eq!(lines, vec!["store updates: ineligible (package)"]);
        let developer = PackageFacts {
            store_signed: false,
            ..store.clone()
        };
        let (_, lines, _) = chosen(true, Some(developer), None, dir());
        assert_eq!(lines, vec!["store updates: ineligible (signature)"]);
        let other_family = PackageFacts {
            family: "O2CSI.Lasterm_other".into(),
            ..store.clone()
        };
        let (_, lines, _) = chosen(true, Some(other_family.clone()), None, dir());
        assert_eq!(lines, vec!["store updates: ineligible (family)"]);
        // Two conditions failing at once: the first in D1's order is named.
        let foreign_unsigned = PackageFacts {
            store_signed: false,
            ..other_family
        };
        let (_, lines, _) = chosen(true, Some(foreign_unsigned.clone()), None, dir());
        assert_eq!(lines, vec!["store updates: ineligible (family)"]);
        let (_, lines, _) = chosen(false, Some(foreign_unsigned), None, dir());
        assert_eq!(lines, vec!["store updates: ineligible (channel)"]);

        // A development build without the variable: channel, and its package
        // is not even read.
        let (result, lines, read) = chosen(false, Some(store.clone()), None, dir());
        assert!(result.is_none());
        assert_eq!(lines, vec!["store updates: ineligible (channel)"]);
        assert!(!read);

        // With a valid script: scripted, the script's version.
        let (result, lines, read) = chosen(false, None, Some(SCRIPT), dir());
        let result = result.expect("eligible by its script");
        assert!(matches!(result.source, Source::Scripted(_)));
        assert_eq!(result.running, RUNNING);
        assert_eq!(lines, vec!["store updates: eligible"]);
        assert!(!read);

        // With an invalid one: ineligible, one WARN.
        let (result, lines, _) = chosen(false, None, Some(r#"{"version":"0.24"}"#), dir());
        assert!(result.is_none());
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].starts_with("WARN: store updates: invalid script ("),
            "{lines:?}"
        );

        // A script that cannot be read: ineligible, one WARN.
        let missing = tempfile_lite::TempDir::new();
        let lines = Mutex::new(Vec::new());
        let result = choose(
            false,
            &|| None,
            Some(missing.path().join("missing.json").into_os_string()),
            &dir,
            &|line| lines.lock().unwrap().push(line.to_string()),
        );
        assert!(result.is_none());
        let lines = lines.into_inner().unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].starts_with("WARN: store updates: invalid script ("),
            "{lines:?}"
        );

        // No configuration directory: one line, ineligible.
        let (result, lines, _) = chosen(true, Some(store), None, Err("no APPDATA".into()));
        assert!(result.is_none());
        assert_eq!(
            lines,
            vec!["store updates: ineligible (config directory: no APPDATA)"]
        );
    }

    #[test]
    fn the_script_refuses_fields_of_the_wrong_form() {
        for invalid in [
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k"}],"signal":false}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k"}],"signal":"maybe"}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k","mandatory":"yes"}]}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k","family":3}]}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k","version":"0.25"}]}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":7}]}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"error":404}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"noAnswer":false}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"error":"0x80004005","signal":17}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"error":"0x80004005","offers":[]}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"noAnswer":true,"offers":3}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"contextError":"x","signal":"true"}]}"#,
            r#"{"version":"0.24.0.0","checks":[{"offers":[],"extra":1}]}"#,
        ] {
            assert!(ScriptedStore::parse(invalid).is_err(), "{invalid}");
        }
        let (_, store) = ScriptedStore::parse(
            r#"{"version":"0.24.0.0","checks":[{"offers":[{"key":"k","version":"0.25.0.0","mandatory":true,"family":"F"}],"signal":"error"}]}"#,
        )
        .unwrap();
        let ScriptCheck::Answer { entries, signal } = &store.checks[0] else {
            panic!("an answer");
        };
        assert_eq!(*signal, Signal::Error);
        assert_eq!(
            entries[0],
            Entry {
                family: "F".into(),
                full_name: "k".into(),
                mandatory: true,
                version: Some(Version4([0, 25, 0, 0])),
            }
        );
    }

    // ── AC-6: reading the Store's answer ──

    fn whole_entry() -> EntryReads {
        EntryReads {
            family: Ok(STORE_FAMILY.into()),
            full_name: Ok(KEY_25.into()),
            mandatory: Ok(true),
            version: Ok(Version4([0, 25, 0, 0])),
        }
    }

    #[test]
    fn a_partial_read_fails_the_check_except_the_version() {
        assert_eq!(
            read_answer(Ok(1), |_| Ok(whole_entry())),
            Ok(vec![offer(KEY_25, Some("0.25.0.0"), true)])
        );
        assert_eq!(
            read_answer(Err("0x1".into()), |_| Ok(whole_entry())),
            Err("0x1".into())
        );
        assert_eq!(
            read_answer(Ok(2), |index| if index == 1 {
                Err("0x2".into())
            } else {
                Ok(whole_entry())
            }),
            Err("0x2".into()),
            "the second entry"
        );
        let broken: [fn() -> EntryReads; 3] = [
            || EntryReads {
                family: Err("0x3".into()),
                ..whole_entry()
            },
            || EntryReads {
                full_name: Err("0x3".into()),
                ..whole_entry()
            },
            || EntryReads {
                mandatory: Err("0x3".into()),
                ..whole_entry()
            },
        ];
        for reads in broken {
            assert_eq!(read_answer(Ok(1), |_| Ok(reads())), Err("0x3".into()));
        }
        assert_eq!(
            read_answer(Ok(1), |_| Ok(EntryReads {
                version: Err("0x4".into()),
                ..whole_entry()
            })),
            Ok(vec![offer(KEY_25, None, true)]),
            "no version: none shown"
        );
    }

    // ── AC-7, D1, D2: attempts, failures and their times ──

    #[test]
    fn a_failure_keeps_its_time_through_the_next_attempt() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).check_now();
        fixture.store.begin();
        let first_attempt = state(&core).last_attempt_at.expect("started");
        fixture
            .store
            .answer(QueryOutcome::Failed("0x80072EE7".into()));
        let failed = state(&core);
        let failed_at = failed.check_failed_at.clone().expect("dated");
        assert_eq!(failed_at, first_attempt);

        fixture.clock.advance(600);
        lock(&core).check_now();
        assert_eq!(fixture.store.queries(), 2, "a check after a failed one");
        fixture.store.begin();
        let during = state(&core);
        assert_ne!(
            during.last_attempt_at.as_deref(),
            Some(first_attempt.as_str())
        );
        assert_eq!(during.check_failed_at.as_deref(), Some(failed_at.as_str()));
        assert!(during.check_error.unwrap().contains("0x80072EE7"));
        fixture.store.answer(answer(vec![], Signal::True));
        let after = state(&core);
        assert_eq!(after.check_error, None);
        assert_eq!(after.check_failed_at, None);
    }

    #[test]
    fn an_answer_past_the_bound_is_no_answer() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).check_now();
        // The poller last ran at 59 s; the answer comes at 61 s, before it runs again.
        poll_for(&fixture, &core, 59);
        fixture.clock.advance(2);
        fixture.store.answer(answer(
            vec![offer(KEY_25, Some("0.25.0.0"), false)],
            Signal::True,
        ));
        let late = state(&core);
        assert!(late.offer.is_none());
        assert_eq!(late.last_checked_at, None);
        assert_eq!(late.check_error.as_deref(), Some(NO_ANSWER));
        assert_eq!(late.checking, Checking::Idle);
        // Reported failed, then asked to stop, as at a timeout (D2).
        assert_eq!(fixture.store.cancels.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_bound_runs_from_the_native_start() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).check_now();
        // Creating the context took 90 s, which D1 leaves unbounded: still
        // running, no failure, no Cancel; the query then has its own 60 s.
        poll_for(&fixture, &core, 90);
        assert_eq!(state(&core).checking, Checking::Running);
        assert_eq!(state(&core).check_error, None);
        assert_eq!(fixture.store.cancels.load(Ordering::SeqCst), 0);
        fixture.store.begin();
        poll_for(&fixture, &core, 59);
        assert_eq!(state(&core).checking, Checking::Running);
        poll_for(&fixture, &core, 1);
        assert_eq!(state(&core).checking, Checking::Waiting);
    }

    #[test]
    fn a_context_failure_is_no_attempt_and_retries_at_the_tick() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).window_shown();
        poll_for(&fixture, &core, 60);
        assert_eq!(fixture.store.queries(), 1);
        fixture
            .store
            .answer(QueryOutcome::ContextFailed("GetDefault 0x80004005".into()));
        let failed = state(&core);
        assert_eq!(failed.last_attempt_at, None, "no native query started");
        assert_eq!(failed.store_error.as_deref(), Some(STORE_UNAVAILABLE));
        // The next tick is 15 minutes after start, not after the failure.
        poll_for(&fixture, &core, TICK.as_secs() - 61);
        assert_eq!(fixture.store.queries(), 1);
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 2, "at the tick");
        // The context, created this time, clears the error at once.
        fixture.store.begin();
        assert_eq!(state(&core).store_error, None);
        assert!(state(&core).last_attempt_at.is_some());
    }

    #[test]
    fn leaving_off_waits_60_s_even_at_a_tick() {
        let fixture = Fixture::new();
        let core = fixture.core();
        check(&fixture, &core, answer(vec![], Signal::True));
        lock(&core).set_mode("off").unwrap();
        // Two days in off; the next poll is a tick, with the last attempt old.
        fixture.clock.jump_civil(2 * DAY);
        fixture.clock.jump_mono(TICK.as_secs() - 1);
        lock(&core).set_mode("ask").unwrap();
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 1, "not at the tick");
        poll_for(&fixture, &core, 58);
        assert_eq!(fixture.store.queries(), 1);
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 2, "60 s after leaving off");
        fixture.store.answer(answer(vec![], Signal::True));
        poll_for(&fixture, &core, 60);
        assert_eq!(fixture.store.queries(), 2, "and only that one");
    }

    // ── D10: one state per seq ──

    #[test]
    fn a_read_never_gives_a_seq_two_states() {
        let fixture = Fixture::new();
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        lock(&core).snooze(KEY_25).unwrap();
        let snoozed = lock(&core).current();
        assert!(!snoozed.wants_dialog);
        // The snooze ends between ticks: the read publishes the change.
        fixture.clock.jump_civil(DAY + 1);
        let read = lock(&core).current();
        assert!(read.wants_dialog);
        assert!(read.seq > snoozed.seq);
        assert_eq!(fixture.last_state(), read);

        // A failed mode change changes no state and publishes nothing.
        let failing = Fixture::new();
        failing.write(r#"{"mode":"ask","lastRunVersion":"0.24.0.0"}"#);
        let core = Core::create_with_replace(
            failing.parts(),
            Box::new(|_, _| Err(std::io::Error::other("injected"))),
        );
        let before = lock(&core).current();
        assert!(lock(&core).set_mode("off").is_err());
        assert_eq!(lock(&core).current(), before);
        assert_eq!(before.save_error, None);

        // Check for updates answers the state, waiting included.
        let waiting = Fixture::new();
        let core = waiting.core();
        assert_eq!(lock(&core).check_now().checking, Checking::Running);
        waiting.store.begin();
        poll_for(&waiting, &core, 60);
        let pressed = lock(&core).check_now();
        assert_eq!(pressed.checking, Checking::Waiting);
        assert_eq!(waiting.store.queries(), 1);
    }

    #[test]
    fn an_empty_answer_with_nothing_to_clear_writes_nothing() {
        let fixture = Fixture::new();
        let core = fixture.core();
        std::fs::remove_file(&fixture.path).unwrap();
        check(&fixture, &core, answer(vec![], Signal::True));
        assert!(!fixture.path.exists());
        // With a snooze to clear, it writes.
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        lock(&core).snooze(KEY_25).unwrap();
        check(&fixture, &core, answer(vec![], Signal::True));
        assert!(fixture.path.exists());
        assert!(!fixture.read().contains("snoozedKey"));
    }

    // ── AC-2: an ineligible build starts nothing ──

    fn wiring(
        backend_made: Arc<AtomicU64>,
        poller_started: Arc<AtomicU64>,
        clock: Arc<TestClock>,
    ) -> Wiring {
        Wiring {
            own_version: "0.24.0".into(),
            backend: Box::new(move |_source| {
                backend_made.fetch_add(1, Ordering::SeqCst);
                Arc::new(RecordingStore {
                    clock: Some(clock.clone()),
                    ..RecordingStore::default()
                }) as Arc<dyn StoreBackend>
            }),
            opener: Arc::new(RecordingOpener::default()),
            clock: TestClock::new(),
            emit: Box::new(|_| {}),
            log: Box::new(|_| {}),
            poller: Box::new(move |_core| {
                poller_started.fetch_add(1, Ordering::SeqCst);
            }),
        }
    }

    #[test]
    fn an_ineligible_build_gets_no_backend_core_or_poller() {
        let made = Arc::new(AtomicU64::new(0));
        let polled = Arc::new(AtomicU64::new(0));
        let ineligible = service(None, wiring(made.clone(), polled.clone(), TestClock::new()));
        let UpdateService::Ineligible(state) = &ineligible else {
            panic!("ineligible");
        };
        assert_eq!(**state, UpdateState::ineligible("0.24.0".into()));
        assert_eq!(made.load(Ordering::SeqCst), 0, "no backend");
        assert_eq!(polled.load(Ordering::SeqCst), 0, "no poller");

        // An eligible one gets each, once.
        let dir = tempfile_lite::TempDir::new();
        let (_, store) =
            ScriptedStore::parse(r#"{"version":"0.24.0.0","checks":[{"noAnswer":true}]}"#).unwrap();
        let chosen = Chosen {
            running: RUNNING,
            source: Source::Scripted(store),
            path: dir.path().join(UPDATES_FILE),
        };
        let eligible = service(
            Some(chosen),
            wiring(made.clone(), polled.clone(), TestClock::new()),
        );
        assert!(matches!(eligible, UpdateService::Eligible(_)));
        assert_eq!(made.load(Ordering::SeqCst), 1);
        assert_eq!(polled.load(Ordering::SeqCst), 1);
    }

    // ── AC-5, AC-7: the scheduler ──

    #[test]
    fn the_daily_check_waits_a_full_day() {
        // Due, it still waits for the 15-minute tick.
        let ticked = Fixture::new();
        let core = ticked.core();
        check(&ticked, &core, answer(vec![], Signal::True));
        ticked.clock.jump_civil(DAY);
        ticked.clock.jump_mono(1);
        lock(&core).poll();
        assert_eq!(ticked.store.queries(), 1, "between ticks");
        ticked.clock.jump_mono(TICK.as_secs() - 1);
        lock(&core).poll();
        assert_eq!(ticked.store.queries(), 2, "at the tick");

        let fixture = Fixture::new();
        let core = fixture.core();
        check(&fixture, &core, answer(vec![], Signal::True));
        fixture.clock.jump_civil(DAY - 1);
        fixture.clock.jump_mono(TICK.as_secs());
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 1, "a second short of a day");
        fixture.clock.jump_civil(1);
        fixture.clock.jump_mono(TICK.as_secs());
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 2, "a day");
    }

    #[test]
    fn no_scheduled_check_while_a_query_is_out_and_one_after_a_failure() {
        // A query that never returns: none for the rest of the run.
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).check_now();
        fixture.store.begin();
        poll_for(&fixture, &core, 60);
        assert_eq!(state(&core).checking, Checking::Waiting);
        for _ in 0..8 {
            fixture.clock.advance(DAY / 4);
            lock(&core).poll();
        }
        assert_eq!(fixture.store.queries(), 1, "two days, still waiting");
        // Once it returns, the first tick after checks.
        fixture.store.answer(answer(vec![], Signal::True));
        fixture.clock.advance(TICK.as_secs());
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 2);

        // After an ordinary failure, the next due check runs.
        let failed = Fixture::new();
        let core = failed.core();
        check(&failed, &core, QueryOutcome::Failed("0x80072EE7".into()));
        failed.clock.advance(DAY);
        lock(&core).poll();
        assert_eq!(failed.store.queries(), 2);
    }

    #[test]
    fn a_daily_check_due_during_a_check_joins_it() {
        let fixture = Fixture::new();
        let core = fixture.core();
        check(&fixture, &core, answer(vec![], Signal::True));
        // A user check just before the tick; civil time jumps a day meanwhile.
        fixture.clock.advance(TICK.as_secs() - 1);
        lock(&core).check_now();
        fixture.store.begin();
        fixture.clock.jump_civil(DAY);
        poll_for(&fixture, &core, 1);
        assert_eq!(fixture.store.queries(), 2);
        fixture.store.answer(answer(vec![], Signal::True));
        // The next tick: that check satisfied the daily one.
        fixture.clock.advance(TICK.as_secs());
        lock(&core).poll();
        assert_eq!(fixture.store.queries(), 2);
    }

    #[test]
    fn an_answer_in_time_counts_though_its_signal_comes_later() {
        let fixture = Fixture::new();
        let core = fixture.core();
        lock(&core).check_now();
        fixture.store.begin();
        poll_for(&fixture, &core, 59);
        let arrived = iso(fixture.clock.civil());
        fixture.store.answered();
        // The signal is read on the main thread, past the bound.
        poll_for(&fixture, &core, 5);
        assert_eq!(state(&core).checking, Checking::Running);
        assert_eq!(fixture.store.cancels.load(Ordering::SeqCst), 0);
        fixture.store.finish(answer(
            vec![offer(KEY_25, Some("0.25.0.0"), false)],
            Signal::True,
        ));
        let done = state(&core);
        assert_eq!(done.offer.map(|offer| offer.key), Some(KEY_25.to_string()));
        assert_eq!(done.check_error, None);
        // Dated when the answer arrived, not when its signal was read.
        assert_eq!(done.last_checked_at, Some(arrived));
    }

    // ── AC-13: a failure re-derives the notices ──

    #[test]
    fn a_failed_check_brings_a_notice_that_came_due() {
        let fixture = Fixture::new();
        let almost = iso(fixture.clock.civil() - WEEK + 60);
        fixture.write(&format!(
            r#"{{"mode":"auto","lastRunVersion":"0.24.0.0","pendingSince":{{"key":"{KEY_25}","at":"{almost}"}}}}"#
        ));
        let core = fixture.core();
        check(
            &fixture,
            &core,
            answer(vec![offer(KEY_25, Some("0.25.0.0"), false)], Signal::True),
        );
        assert!(state(&core).notices.is_empty(), "a minute short of 7 days");
        fixture.clock.advance(120);
        check(&fixture, &core, QueryOutcome::Failed("0x80072EE7".into()));
        assert_eq!(kinds(&fixture.last_state()), vec![NoticeKind::Waiting]);
    }

    #[test]
    fn the_ineligible_state_has_exactly_its_fields() {
        let state = serde_json::to_value(UpdateState::ineligible("0.24.0".into())).unwrap();
        assert_eq!(
            state,
            serde_json::json!({
                "seq": 1,
                "eligible": false,
                "mode": "ask",
                "runningVersion": "0.24.0",
                "checking": "idle",
                "wantsDialog": false,
                "notices": []
            })
        );
    }
}
