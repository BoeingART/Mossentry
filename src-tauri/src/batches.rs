use crate::{
    db::{self, n, s},
    error::{Error, Result},
    model,
    service::Service,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub fn pending(c: &Connection) -> Result<i64> {
    if let Some(batch) = db::row(
        c,
        "SELECT id FROM approval_batches WHERE status='pending' ORDER BY id DESC LIMIT 1",
        [],
    )? {
        return Ok(n(&batch, "id"));
    }
    c.execute(
        "INSERT INTO approval_batches(created_at) VALUES(?)",
        [db::now()],
    )?;
    Ok(c.last_insert_rowid())
}
pub fn migrate(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE INDEX IF NOT EXISTS idx_actions_batch ON actions(batch_id);")?;
    if db::row(
        c,
        "SELECT id FROM actions WHERE batch_id IS NULL AND status='pending' LIMIT 1",
        [],
    )?
    .is_some()
    {
        let batch = pending(c)?;
        c.execute(
            "UPDATE actions SET batch_id=? WHERE batch_id IS NULL AND status='pending'",
            [batch],
        )?;
    }
    finish(c)
}
pub fn finish(c: &Connection) -> Result<()> {
    c.execute("UPDATE approval_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM actions WHERE batch_id=approval_batches.id AND status='failed') THEN 'failed' WHEN NOT EXISTS(SELECT 1 FROM actions WHERE batch_id=approval_batches.id AND status='executed') THEN 'rejected' ELSE 'executed' END,executed_at=? WHERE status IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM actions WHERE batch_id=approval_batches.id AND status IN ('pending','approved'))",[db::now()])?;
    Ok(())
}
impl Service {
    fn batch_items(&self, id: i64) -> Result<Vec<Value>> {
        let c = self.connection()?;
        if db::row(
            &c,
            "SELECT id FROM approval_batches WHERE id=? AND status='pending'",
            [id],
        )?
        .is_none()
        {
            return Err(Error::new(
                409,
                "This approval list has already been handled",
            ));
        }
        let items = db::rows(
            &c,
            "SELECT * FROM actions WHERE batch_id=? AND status='pending' ORDER BY id",
            [id],
        )?;
        if items.is_empty() {
            return Err(Error::bad("The approval list is empty"));
        }
        Ok(items)
    }
    pub fn remove_batch_item(&self, batch: i64, item: i64) -> Result<Value> {
        let items = self.batch_items(batch)?;
        if !items.iter().any(|entry| n(entry, "id") == item) {
            return Err(Error::new(404, "Operation not found in this approval list"));
        }
        self.reject(item)
    }
    pub fn reject_batch(&self, id: i64) -> Result<Value> {
        self.batch_items(id)?;
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        tx.execute("UPDATE actions SET status='rejected',approved_at=?,approved_by=(SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1) WHERE batch_id=? AND status='pending'",params![db::now(),id])?;
        tx.execute(
            "UPDATE approval_batches SET status='rejected',approved_at=?,executed_at=? WHERE id=?",
            params![db::now(), db::now(), id],
        )?;
        db::audit(
            &tx,
            "approval_batch_rejected",
            Some(&format!("batch:{id}")),
            json!({}),
        )?;
        tx.commit()?;
        Ok(json!({"ok":true}))
    }
    pub fn approve_batch(&self, id: i64) -> Result<Value> {
        let items = self.batch_items(id)?;
        // Validate every item/host before the first remote mutation.
        let preflight = (|| -> Result<()> {
            for item in &items {
                let payload: Value = serde_json::from_str(s(item, "payload_json"))?;
                let names = self.validate_servers(&model::server_names(&payload["servers"])?)?;
                self.protect(s(item, "target_user"), &names)?;
                self.run_accounts(&names,"preflight",&json!({"managed_username":item["target_user"],"managed_create":item["action_type"]=="create_user"}),45).map_err(Error::remote)?;
            }
            Ok(())
        })();
        let mut c = self.connection()?;
        if let Err(error) = preflight {
            let tx = c.transaction()?;
            tx.execute("UPDATE actions SET status='failed',error=?,executed_at=? WHERE batch_id=? AND status='pending'",params![error.detail,db::now(),id])?;
            tx.execute(
                "UPDATE approval_batches SET status='failed',error=?,executed_at=? WHERE id=?",
                params![error.detail, db::now(), id],
            )?;
            db::audit(
                &tx,
                "approval_batch_failed",
                Some(&format!("batch:{id}")),
                json!({"error":error.detail,"preflight":true}),
            )?;
            tx.commit()?;
            return Err(error);
        }
        c.execute(
            "UPDATE approval_batches SET status='approved',approved_at=? WHERE id=?",
            params![db::now(), id],
        )?;
        db::audit(
            &c,
            "approval_batch_approved",
            Some(&format!("batch:{id}")),
            json!({"operations":items.len()}),
        )?;
        let mut errors = Vec::new();
        let mut refresh_warning = false;
        for item in &items {
            if let Err(error) = self.approve(n(item, "id")).map(|result| {
                refresh_warning |= !result["warning"].is_null();
            }) {
                // Validation can fail before approve records its running state.
                c.execute("UPDATE actions SET status='failed',error=?,executed_at=? WHERE id=? AND status='pending'",params![error.detail,db::now(),n(item,"id")])?;
                errors.push(format!("{}: {}", s(item, "target_user"), error.detail));
            }
        }
        finish(&c)?;
        c.execute(
            "UPDATE approval_batches SET error=? WHERE id=?",
            params![
                if errors.is_empty() {
                    None
                } else {
                    Some(errors.join("\n"))
                },
                id
            ],
        )?;
        db::audit(
            &c,
            "approval_batch_finished",
            Some(&format!("batch:{id}")),
            json!({"failed":errors.len(),"operations":items.len()}),
        )?;
        Ok(
            json!({"ok":errors.is_empty(),"completed":items.len()-errors.len(),"failed":errors.len(),"warning":if !errors.is_empty(){Some("Some operations in the approval list failed. Review their results.")}else if refresh_warning {Some("The action completed, but the account list could not refresh. Sync the affected servers again.")}else{None}}),
        )
    }
}
