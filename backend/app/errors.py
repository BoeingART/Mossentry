def friendly_error(raw: str | None) -> str | None:
    """Keep execution output in local records, never send it as UI copy."""
    if not raw:
        return None
    text = raw.lower()
    if "host key verification failed" in text or "identification has changed" in text:
        return "Verify this server's SSH fingerprint and update the local known hosts file, then retry."
    if "no such identity" in text or "private key" in text or "unprotected private" in text:
        return "Check that the SSH private key exists and only its owner can read it."
    if "permission denied" in text or "authentication" in text:
        return "SSH sign-in failed. Check the login account and private key."
    if "sudo" in text or "become" in text or "privilege" in text:
        return "The management account needs sudo permission. Check its permissions and retry."
    if "timed out" in text or "timeout" in text:
        return "The server did not respond in time. Check its address and network connection."
    if "resolve" in text or "name or service" in text:
        return "The server address could not be found. Check the hostname."
    if "refused" in text or "unreachable" in text or "no route" in text:
        return "Cannot connect to SSH. Check the server, port and network connection."
    if "ansible-playbook is missing" in text:
        return "The connection service is unavailable. Install the application's backend dependencies."
    if "in use" in text or "currently used by process" in text:
        return "This account has running processes. End its sessions before deleting it."
    return "The operation could not finish. Check the server connection and management permissions, then retry."
