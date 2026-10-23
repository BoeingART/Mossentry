use crate::{
    db::{self, s},
    error::{Error, Result},
    service::Service,
    ssh,
};
use serde_json::{json, Value};

impl Service {
    pub fn firewall(&self, server: &Value, body: Value) -> Result<Value> {
        let operation = s(&body, "operation");
        if !["status", "enable", "disable", "add", "delete"].contains(&operation) {
            return Err(Error::bad("Unknown firewall operation."));
        }
        let result = self
            .remote(server, ssh::FIREWALL, &body, true, 120)
            .map_err(Error::remote)
            .and_then(|value| {
                if let Some(error) = value["error"].as_str() {
                    return Err(Error::new(409, error));
                }
                if !value["available"].is_boolean()
                    || value["available"] == true
                        && (!value["enabled"].is_boolean()
                            || !value["ssh_allowed"].is_boolean()
                            || !value["rules"].is_array()
                            || !value["revision"].is_string())
                {
                    return Err(Error::remote("Invalid firewall response"));
                }
                if value["available"] == false && operation != "status" {
                    return Err(Error::bad("UFW is not installed on this server."));
                }
                Ok(value)
            });
        db::audit(
            &self.connection()?,
            if result.is_err() {
                "firewall_failed"
            } else if operation == "status" {
                "firewall_checked"
            } else {
                "firewall_changed"
            },
            Some(s(server, "name")),
            json!({"operation":operation,"request":body,"ok":result.is_ok()}),
        )?;
        result
    }
}
