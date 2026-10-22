use crate::{
    config,
    error::{Error, Result},
    model::ServerInput,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Directive {
    pub key: String,
    pub value: String,
    include_boundary: Option<bool>,
}
pub struct SshConfig {
    pub directives: Vec<Directive>,
    pub aliases: Vec<String>,
    pub revision: String,
}
pub struct Import {
    pub servers: Vec<ServerInput>,
    pub warnings: Vec<String>,
    pub revision: String,
}
pub fn default_path() -> PathBuf {
    config::expand_path("~/.ssh/config")
}

pub fn login_option(key: &str) -> bool {
    matches!(
        key,
        "identityfile"
            | "certificatefile"
            | "proxyjump"
            | "proxycommand"
            | "identityagent"
            | "identitiesonly"
            | "pubkeyauthentication"
            | "preferredauthentications"
            | "passwordauthentication"
            | "kbdinteractiveauthentication"
            | "hostkeyalias"
            | "userknownhostsfile"
            | "globalknownhostsfile"
            | "stricthostkeychecking"
            | "checkhostip"
            | "hashknownhosts"
            | "hostkeyalgorithms"
            | "pubkeyacceptedalgorithms"
            | "pubkeyacceptedkeytypes"
            | "casignaturealgorithms"
            | "kexalgorithms"
            | "ciphers"
            | "macs"
            | "connecttimeout"
            | "connectionattempts"
            | "serveraliveinterval"
            | "serveralivecountmax"
            | "tcpkeepalive"
            | "compression"
            | "forwardagent"
            | "addressfamily"
            | "bindaddress"
            | "bindinterface"
            | "addkeystoagent"
            | "usekeychain"
            | "pkcs11provider"
            | "securitykeyprovider"
            | "gssapiauthentication"
            | "gssapidelegatecredentials"
    )
}

pub fn validate_options(text: &str, host_blocks: bool) -> Result<()> {
    if text.len() > 65536
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(Error::bad("Invalid or oversized SSH login settings"));
    }
    let mut jump = false;
    let mut proxy = false;
    for line in text.lines() {
        let Some(d) = directive(line)? else {
            continue;
        };
        if host_blocks && d.key == "host" {
            if jump && proxy {
                return Err(Error::bad("Use either ProxyJump or ProxyCommand, not both"));
            }
            jump = false;
            proxy = false;
            for alias in words(&d.value)? {
                if !crate::model::matches(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", &alias) {
                    return Err(Error::bad("Invalid SSH Host alias"));
                }
            }
            continue;
        }
        if host_blocks && matches!(d.key.as_str(), "hostname" | "user" | "port") {
            let value = scalar(&d.value)?;
            if d.key == "hostname" && !crate::model::matches(r"^[A-Za-z0-9_.:%\[\]-]+$", &value)
                || d.key == "user"
                    && !crate::model::matches(r"^[A-Za-z0-9_][A-Za-z0-9_.@\\$%-]{0,127}$", &value)
                || d.key == "port" && value.parse::<u16>().map_or(true, |p| p == 0)
            {
                return Err(Error::bad("Invalid jump host connection settings"));
            }
            continue;
        }
        if !login_option(&d.key) {
            return Err(Error::bad(format!(
                "Unsupported SSH login option: {}",
                d.key
            )));
        }
        if d.key == "proxyjump" {
            let value = scalar(&d.value)?;
            if !crate::model::matches(r"^[A-Za-z0-9_.@%:\[\],+-]+$", &value) {
                return Err(Error::bad("Invalid ProxyJump value"));
            }
            jump |= value != "none";
        }
        proxy |= d.key == "proxycommand" && d.value.trim() != "none";
        if [
            "connecttimeout",
            "connectionattempts",
            "serveraliveinterval",
            "serveralivecountmax",
        ]
        .contains(&d.key.as_str())
        {
            let value = scalar(&d.value)?;
            if value.parse::<u32>().is_err() {
                return Err(Error::bad(
                    "SSH timeouts and keepalive values must be non-negative integers",
                ));
            }
        }
    }
    if jump && proxy {
        return Err(Error::bad("Use either ProxyJump or ProxyCommand, not both"));
    }
    Ok(())
}

pub fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

// OpenSSH quoting, without shell expansion or execution. Backslashes in Windows
// paths remain literal unless escaping a quote, whitespace, # or a backslash.
pub fn words(value: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '\\' if chars
                .peek()
                .is_some_and(|c| matches!(c, '"' | '\\' | '#' | ' ' | '\t')) =>
            {
                word.push(chars.next().unwrap());
                started = true;
            }
            '#' if !quoted => break,
            c if c.is_whitespace() && !quoted => {
                if started {
                    result.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            _ => {
                word.push(c);
                started = true;
            }
        }
    }
    if quoted {
        return Err(Error::bad("Unclosed quote in SSH config"));
    }
    if started {
        result.push(word);
    }
    Ok(result)
}
pub fn directive(line: &str) -> Result<Option<Directive>> {
    let line = line.trim().trim_start_matches('\u{feff}');
    if line.is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .ok_or_else(|| Error::bad("Missing value in SSH config"))?;
    let key = line[..end].to_ascii_lowercase();
    let value = line[end..]
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(line[end..].trim_start())
        .trim();
    if words(value)?.is_empty() {
        return Err(Error::bad("Missing value in SSH config"));
    }
    Ok(Some(Directive {
        key,
        value: value.to_owned(),
        include_boundary: None,
    }))
}
pub fn scalar(value: &str) -> Result<String> {
    let values = words(value)?;
    if values.len() != 1 {
        return Err(Error::bad("Expected one value in SSH config"));
    }
    Ok(values[0].clone())
}
fn read(
    path: &Path,
    directives: &mut Vec<Directive>,
    stack: &mut HashSet<PathBuf>,
    bytes: &mut usize,
) -> Result<()> {
    if stack.len() >= 16 {
        return Err(Error::bad("SSH config Include nesting is too deep"));
    }
    let path = fs::canonicalize(path).map_err(|_| Error::bad("Could not read SSH config file"))?;
    if !stack.insert(path.clone()) {
        return Err(Error::bad("SSH config contains an Include cycle"));
    }
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() || metadata.len() > 2_000_000 {
        return Err(Error::bad("SSH config file is too large"));
    }
    let text =
        fs::read_to_string(&path).map_err(|_| Error::bad("Could not read SSH config as UTF-8"))?;
    *bytes += text.len();
    if *bytes > 2_000_000 {
        return Err(Error::bad("SSH config file is too large"));
    }
    for line in text.lines() {
        let Some(d) = directive(line)? else {
            continue;
        };
        if d.key == "match" {
            return Err(Error::bad(
                "Match blocks are not supported. Use a config with Host blocks.",
            ));
        }
        if d.key != "include" {
            directives.push(d);
            continue;
        }
        for pattern in words(&d.value)? {
            let included = config::expand_path(&pattern);
            let included = if included.is_absolute() {
                included
            } else {
                config::expand_path("~/.ssh").join(included)
            };
            let mut paths = glob::glob(&included.to_string_lossy())
                .map_err(|_| Error::bad("Invalid SSH config Include pattern"))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| Error::bad("Could not read SSH config Include"))?;
            paths.sort();
            for path in paths {
                directives.push(Directive {
                    key: String::new(),
                    value: String::new(),
                    include_boundary: Some(true),
                });
                read(&path, directives, stack, bytes)?;
                directives.push(Directive {
                    key: String::new(),
                    value: String::new(),
                    include_boundary: Some(false),
                });
            }
        }
    }
    stack.remove(&path);
    Ok(())
}
pub fn pattern_matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for pattern in patterns {
        let negated = pattern.starts_with('!');
        let pattern = pattern.trim_start_matches('!').to_ascii_lowercase();
        let matched =
            glob::Pattern::new(&pattern).is_ok_and(|p| p.matches(&alias.to_ascii_lowercase()));
        if matched && negated {
            return false;
        }
        positive |= matched;
    }
    positive
}
impl SshConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let mut directives = Vec::new();
        read(path, &mut directives, &mut HashSet::new(), &mut 0)?;
        let mut aliases = Vec::new();
        let mut digest = Sha256::new();
        for d in &directives {
            digest.update(format!("{:?} {} {}\n", d.include_boundary, d.key, d.value));
            if d.key == "host" {
                for alias in words(&d.value)? {
                    if !alias.contains(['*', '?', '[', '!', '%']) && !aliases.contains(&alias) {
                        if !crate::model::matches(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", &alias) {
                            return Err(Error::bad("Unsupported SSH Host alias"));
                        }
                        aliases.push(alias);
                    }
                }
            }
        }
        if aliases.is_empty() || aliases.len() > 500 {
            return Err(Error::bad(
                "SSH config must contain between 1 and 500 explicit Host aliases",
            ));
        }
        let mut parsed = Self {
            directives,
            aliases,
            revision: format!("{:x}", digest.finalize()),
        };
        let mut active_aliases = Vec::new();
        for alias in &parsed.aliases {
            if parsed.resolve_internal(alias)?.1 {
                active_aliases.push(alias.clone());
            }
        }
        parsed.aliases = active_aliases;
        if parsed.aliases.is_empty() {
            return Err(Error::bad(
                "SSH config contains no active explicit Host aliases",
            ));
        }
        Ok(parsed)
    }
    pub fn resolve(&self, alias: &str) -> Result<BTreeMap<String, Vec<String>>> {
        Ok(self.resolve_internal(alias)?.0)
    }
    fn resolve_internal(&self, alias: &str) -> Result<(BTreeMap<String, Vec<String>>, bool)> {
        let mut result = BTreeMap::<String, Vec<String>>::new();
        let mut active = true;
        let mut scopes = Vec::new();
        let mut explicit = false;
        for d in &self.directives {
            if let Some(start) = d.include_boundary {
                if start {
                    scopes.push(active);
                } else {
                    active = scopes.pop().unwrap_or(true);
                }
                continue;
            }
            if d.key == "host" {
                let patterns = words(&d.value)?;
                active =
                    scopes.last().copied().unwrap_or(true) && pattern_matches(&patterns, alias);
                explicit |= active && patterns.iter().any(|p| p.eq_ignore_ascii_case(alias));
                continue;
            }
            if !active {
                continue;
            }
            if matches!(d.key.as_str(), "identityfile" | "certificatefile") {
                let values = result.entry(d.key.clone()).or_default();
                if !values.contains(&d.value) {
                    values.push(d.value.clone());
                }
            } else {
                result
                    .entry(d.key.clone())
                    .or_insert_with(|| vec![d.value.clone()]);
            }
        }
        Ok((result, explicit))
    }
    fn jump_context(&self, alias: &str) -> Result<String> {
        fn collect(
            config: &SshConfig,
            alias: &str,
            active: &mut HashSet<String>,
            done: &mut HashSet<String>,
            output: &mut String,
        ) -> Result<()> {
            if !active.insert(alias.to_ascii_lowercase()) {
                return Err(Error::bad("SSH config contains a ProxyJump cycle"));
            }
            if active.len() > 8 {
                return Err(Error::bad("SSH ProxyJump chain is too deep"));
            }
            let options = config.resolve(alias)?;
            if let Some(values) = options.get("proxyjump") {
                let jump = scalar(&values[0])?;
                if jump != "none" {
                    for destination in jump.split(',') {
                        let host = destination.rsplit('@').next().unwrap_or(destination);
                        let host = if let Some(ipv6) = host.strip_prefix('[') {
                            ipv6.split(']').next().unwrap_or(ipv6)
                        } else {
                            host.split(':').next().unwrap_or(host)
                        };
                        if host.contains(':') || host.contains('%') {
                            continue;
                        }
                        if !done.contains(&host.to_ascii_lowercase()) {
                            collect(config, host, active, done, output)?;
                            output.push_str(&format!("Host {host}\n"));
                            for (key, values) in config.resolve(host)? {
                                if login_option(&key)
                                    || ["hostname", "user", "port"].contains(&key.as_str())
                                {
                                    for value in values {
                                        output.push_str(&format!("  {key} {value}\n"));
                                    }
                                }
                            }
                            done.insert(host.to_ascii_lowercase());
                        }
                    }
                }
            }
            active.remove(&alias.to_ascii_lowercase());
            Ok(())
        }
        let mut output = String::new();
        collect(
            self,
            alias,
            &mut HashSet::new(),
            &mut HashSet::new(),
            &mut output,
        )?;
        validate_options(&output, true)?;
        Ok(output)
    }
    pub fn import(&self) -> Result<Import> {
        let mut servers = Vec::new();
        let mut warnings = Vec::new();
        let mut names = HashSet::new();
        for alias in &self.aliases {
            let options = self.resolve(alias)?;
            let get = |name: &str| -> Result<Option<String>> {
                options.get(name).map(|v| scalar(&v[0])).transpose()
            };
            let hostname = get("hostname")?
                .unwrap_or_else(|| alias.clone())
                .replace("%h", alias);
            let user = get("user")?.unwrap_or_else(|| {
                std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" })
                    .unwrap_or_else(|_| "root".into())
            });
            let port = get("port")?
                .unwrap_or_else(|| "22".into())
                .parse::<u16>()
                .map_err(|_| Error::bad("Invalid SSH config Port"))?;
            let key = get("identityfile")?.unwrap_or_default();
            let key = if key == "none" || key.contains("${") || key.contains('%') {
                String::new()
            } else {
                let path = config::expand_path(&key);
                if path.is_absolute() {
                    path.to_string_lossy().into_owned()
                } else {
                    String::new()
                }
            };
            let mut login_settings = String::new();
            for (keyword, values) in &options {
                if login_option(keyword) {
                    for (index, value) in values.iter().enumerate() {
                        if keyword == "identityfile" && index == 0 && !key.is_empty() {
                            continue;
                        }
                        login_settings.push_str(&format!("{keyword} {value}\n"));
                    }
                }
            }
            let jump_config = self.jump_context(alias)?;
            let mut name = alias.to_ascii_lowercase().replace('.', "_");
            if !name.starts_with(|c: char| c.is_ascii_lowercase()) {
                name = format!("host_{name}");
            }
            name.truncate(27);
            if ["all", "ungrouped", "managed"].contains(&name.as_str()) {
                name = format!("host_{name}");
            }
            let base = name.clone();
            let mut index = 2;
            while !names.insert(name.clone()) {
                name = format!("{base}_{index}");
                index += 1;
            }
            for keyword in options
                .keys()
                .filter(|k| !login_option(k) && !["hostname", "user", "port"].contains(&k.as_str()))
            {
                let warning = format!("Unsupported SSH option: {keyword}");
                if !warnings.contains(&warning) {
                    warnings.push(warning);
                }
            }
            let server = ServerInput::parse(
                json!({"name":name,"hostname":hostname,"port":port,"ssh_user":user,"key_path":key,"enabled":false,"ssh_backend":"openssh","ssh_alias":alias,"ssh_options":login_settings,"ssh_jump_config":jump_config}),
            )?;
            servers.push(server);
        }
        Ok(Import {
            servers,
            warnings,
            revision: self.revision.clone(),
        })
    }
}
