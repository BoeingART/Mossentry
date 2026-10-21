use crate::{
    db::{self, n, s},
    error::Result,
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::BTreeMap;
fn date(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
fn priority(s: &str) -> u8 {
    match s {
        "auth_log" | "journal" => 0,
        "home_birth" => 1,
        _ => 2,
    }
}
pub fn remember(c: &Connection) -> Result<()> {
    for account in db::rows(
        c,
        "SELECT username,created_at,created_at_source,scanned_at FROM server_users",
        [],
    )? {
        let name = s(&account, "username");
        if let Some(previous) = db::row(c, "SELECT * FROM user_history WHERE username=?", [name])? {
            let candidate = date(&account["created_at"]);
            let before = date(&previous["created_at"]);
            let new_priority = priority(s(&account, "created_at_source"));
            let old_priority = priority(s(&previous, "created_at_source"));
            let replace = candidate.is_some()
                && (before.is_none()
                    || new_priority < old_priority
                    || (new_priority == old_priority && candidate < before));
            let origin = if replace { &account } else { &previous };
            c.execute("UPDATE user_history SET created_at=?,created_at_source=?,first_seen_at=?,last_seen_at=? WHERE username=?",params![origin["created_at"].as_str(),origin["created_at_source"].as_str(),s(&previous,"first_seen_at").min(s(&account,"scanned_at")),s(&previous,"last_seen_at").max(s(&account,"scanned_at")),name])?;
        } else {
            c.execute("INSERT INTO user_history(username,created_at,created_at_source,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)",params![name,account["created_at"].as_str(),account["created_at_source"].as_str(),s(&account,"scanned_at"),s(&account,"scanned_at")])?;
        }
    }
    c.execute("UPDATE user_history SET dashboard_eligible=(SELECT MAX(uid>=1000 OR is_disabled=0) FROM server_users WHERE server_users.username=user_history.username) WHERE username IN (SELECT username FROM server_users)",[])?;
    Ok(())
}
pub fn statistics(c: &Connection) -> Result<Value> {
    let end = Utc::now();
    let start = end - Duration::days(30);
    let mut daily = BTreeMap::<String, i64>::new();
    let mut recent = 0;
    let users = db::rows(
        c,
        "SELECT created_at FROM user_history WHERE dashboard_eligible=1",
        [],
    )?;
    for u in &users {
        if let Some(d) = date(&u["created_at"]).filter(|d| *d <= end) {
            *daily.entry(d.date_naive().to_string()).or_default() += 1;
            if d >= start {
                recent += 1;
            }
        }
    }
    let mut running = 0;
    let history: Vec<Value> = daily
        .into_iter()
        .map(|(d, added)| {
            running += added;
            json!({"date":d,"added":added,"total":running})
        })
        .collect();
    let recent_count = |query: &str| -> Result<usize> {
        Ok(db::rows(c, query, [])?
            .iter()
            .filter(|r| date(&r["date"]).is_some_and(|d| d >= start && d <= end))
            .count())
    };
    let pending = db::row(
        c,
        "SELECT COUNT(*) AS count FROM actions WHERE status='pending'",
        [],
    )?
    .unwrap();
    Ok(
        json!({"total_unique_users":users.len(),"dated_users":running,"undated_users":users.len() as i64-running,"new_users_30d":recent,
        "new_accounts_30d":recent_count("SELECT created_at AS date FROM server_users WHERE uid>=1000 OR is_disabled=0")?,
        "new_servers_30d":recent_count("SELECT created_at AS date FROM audit_log WHERE event='server_created'")?,
        "pending_approvals":n(&pending,"count"),"new_pending_approvals_30d":recent_count("SELECT requested_at AS date FROM actions WHERE status='pending'")?,
        "history":history,"through":end.date_naive().to_string()}),
    )
}
