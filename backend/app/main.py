from __future__ import annotations

import json
import hmac
import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import ansible_service
from .config import BASE_DIR, COOKIE_SECURE, DATA_DIR, SESSION_HOURS
from .db import audit, connect, create_session, execute, get_session, init_db, now, row, rows
from .models import USERNAME_RE, CreateUserRequest, LoginRequest, PasswordChangeRequest, UserActionRequest, UserProfileUpdate
from .security import hash_password, verify_password

app = FastAPI(title="Server Manager", docs_url=None, redoc_url=None)
DESKTOP_TOKEN = os.environ.get("SRVMGR_DESKTOP_TOKEN", "")
DESKTOP_CSRF = secrets.token_urlsafe(32)
app.mount("/static", StaticFiles(directory=BASE_DIR / "app" / "static"), name="static")
templates = Environment(
    loader=FileSystemLoader(BASE_DIR / "app" / "templates"),
    autoescape=select_autoescape(["html", "xml"]),
)


@app.middleware("http")
async def desktop_access(request: Request, call_next):
    if DESKTOP_TOKEN and not hmac.compare_digest(request.headers.get("x-desktop-token", ""), DESKTOP_TOKEN):
        return JSONResponse({"detail": "Access is limited to the desktop app"}, status_code=403)
    return await call_next(request)


@app.on_event("startup")
def startup() -> None:
    init_db()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _desktop_admin() -> dict[str, Any]:
    admin = row("SELECT id,username FROM admins WHERE active=1 ORDER BY id LIMIT 1")
    if not admin:
        raise HTTPException(500, "No administrator account is available")
    return {"admin_id": admin["id"], "username": admin["username"], "csrf_token": DESKTOP_CSRF}


def current_admin(session_id: str | None = Cookie(default=None)) -> dict[str, Any]:
    session = _desktop_admin() if DESKTOP_TOKEN else get_session(session_id)
    if not session:
        raise HTTPException(401, "Sign in first")
    return session


def csrf_admin(
    session: dict[str, Any] = Depends(current_admin),
    x_csrf_token: str | None = Header(default=None),
) -> dict[str, Any]:
    if not x_csrf_token or x_csrf_token != session["csrf_token"]:
        raise HTTPException(403, "Security check failed. Refresh the page and try again")
    return session


@app.get("/", response_class=HTMLResponse)
def home(session_id: str | None = Cookie(default=None)) -> HTMLResponse:
    session = _desktop_admin() if DESKTOP_TOKEN else get_session(session_id)
    name = "dashboard.html" if session else "login.html"
    response = HTMLResponse(templates.get_template(name).render(session=session, desktop_mode=bool(DESKTOP_TOKEN)))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/login")
def login(body: LoginRequest, request: Request) -> Response:
    if DESKTOP_TOKEN:
        raise HTTPException(404, "Sign-in is not required in the desktop app")
    admin = row("SELECT * FROM admins WHERE username=? AND active=1", (body.username,))
    if not admin or not verify_password(body.password, admin["password_hash"]):
        audit(admin["id"] if admin else None, "login_failed", body.username, {}, _client_ip(request))
        raise HTTPException(401, "Incorrect username or password")
    session_id, csrf = create_session(admin["id"])
    audit(admin["id"], "login_success", body.username, {}, _client_ip(request))
    response = JSONResponse({"ok": True, "csrf": csrf})
    response.set_cookie(
        "session_id", session_id, max_age=SESSION_HOURS * 3600, httponly=True,
        secure=COOKIE_SECURE, samesite="strict", path="/",
    )
    return response


@app.post("/api/logout")
def logout(
    request: Request,
    session: dict[str, Any] = Depends(csrf_admin),
    session_id: str | None = Cookie(default=None),
) -> Response:
    if DESKTOP_TOKEN:
        raise HTTPException(404, "Sign-out is not available in the desktop app")
    if session_id:
        execute("DELETE FROM sessions WHERE id=?", (session_id,))
    audit(session["admin_id"], "logout", session["username"], {}, _client_ip(request))
    response = JSONResponse({"ok": True})
    response.delete_cookie("session_id", path="/")
    return response


@app.get("/api/dashboard")
def dashboard(session: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
    servers = rows(
        """SELECT id,name,hostname,port,public_port_start,public_port_end,ssh_user,enabled,
        last_scan_at,last_scan_status,last_scan_error FROM servers ORDER BY name"""
    )
    users = rows(
        """SELECT su.*, s.name AS server, COALESCE(up.full_name, '') AS full_name
        FROM server_users su
        JOIN servers s ON s.id=su.server_id
        LEFT JOIN user_profiles up ON up.username=su.username
        ORDER BY su.username,s.name"""
    )
    actions = rows(
        """SELECT ac.id,ac.action_type,ac.target_server,ac.target_user,ac.payload_json,ac.status,
        ac.requested_at,ac.approved_at,ac.executed_at,ac.error,ac.key_fingerprint,
        ac.private_key_path,ac.key_downloaded_at,req.username AS requested_by_name,
        app.username AS approved_by_name
        FROM actions ac JOIN admins req ON req.id=ac.requested_by
        LEFT JOIN admins app ON app.id=ac.approved_by ORDER BY ac.id DESC LIMIT 100"""
    )
    for action in actions:
        action["payload"] = json.loads(action.pop("payload_json"))
        action["private_key_ready"] = bool(action.pop("private_key_path")) and not action["key_downloaded_at"]
        if action["error"]:
            action["error"] = action["error"][-1500:]
    logs = rows(
        """SELECT al.id,al.event,al.target,al.details_json,al.ip_address,al.created_at,a.username AS actor
        FROM audit_log al LEFT JOIN admins a ON a.id=al.actor_id ORDER BY al.id DESC LIMIT 100"""
    )
    for log in logs:
        log["details"] = json.loads(log.pop("details_json"))
    return {
        "admin": {"username": session["username"], "csrf": session["csrf_token"]},
        "servers": servers, "users": users, "actions": actions, "audit": logs,
    }


def _validate_servers(names: list[str]) -> list[str]:
    unique = list(dict.fromkeys(names))
    found = {item["name"] for item in rows(
        f"SELECT name FROM servers WHERE enabled=1 AND name IN ({','.join('?' for _ in unique)})",
        tuple(unique),
    )} if unique else set()
    if not unique or set(unique) != found:
        raise HTTPException(400, "The selection includes an unknown or disabled host")
    return unique


def _queue_action(
    action_type: str, username: str, servers: list[str], payload: dict[str, Any],
    session: dict[str, Any], request: Request,
) -> int:
    action_id = execute(
        """INSERT INTO actions(action_type,target_server,target_user,payload_json,status,requested_by,requested_at)
        VALUES(?,?,?,?,?,?,?)""",
        (action_type, ",".join(servers), username, json.dumps(payload, ensure_ascii=False), "pending", session["admin_id"], now()),
    )
    audit(session["admin_id"], "action_requested", f"action:{action_id}", {
        "type": action_type, "username": username, "servers": servers,
        **({"sudo": payload["sudo"]} if "sudo" in payload else {}),
    }, _client_ip(request))
    return action_id


@app.post("/api/actions/create-user")
def request_create_user(
    body: CreateUserRequest, request: Request, session: dict[str, Any] = Depends(csrf_admin),
) -> dict[str, Any]:
    servers = _validate_servers(body.servers)
    action_id = _queue_action("create_user", body.username, servers, {
        "servers": servers, "sudo": body.sudo, "full_name": body.full_name.strip()[:100],
    }, session, request)
    return {"ok": True, "action_id": action_id, "message": "The creation request is pending approval"}


@app.post("/api/actions/user")
def request_user_action(
    body: UserActionRequest, request: Request, session: dict[str, Any] = Depends(csrf_admin),
) -> dict[str, Any]:
    servers = _validate_servers(body.servers)
    if body.action == "set_sudo" and body.sudo is None:
        raise HTTPException(400, "Specify the desired sudo access")
    payload: dict[str, Any] = {"servers": servers}
    if body.action == "set_sudo":
        payload["sudo"] = body.sudo
    action_id = _queue_action(body.action, body.username, servers, payload, session, request)
    return {"ok": True, "action_id": action_id, "message": "The request is pending approval"}


@app.put("/api/users/{username}/profile")
def update_user_profile(
    username: str, body: UserProfileUpdate, request: Request,
    session: dict[str, Any] = Depends(csrf_admin),
) -> dict[str, Any]:
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(400, "Invalid username")
    if not row("SELECT 1 FROM server_users WHERE username=? LIMIT 1", (username,)):
        raise HTTPException(404, "User not found. Sync hosts first")
    full_name = body.full_name.strip()
    previous = row("SELECT full_name FROM user_profiles WHERE username=?", (username,))
    with connect() as conn:
        if full_name:
            conn.execute(
                """INSERT INTO user_profiles(username,full_name,updated_at,updated_by) VALUES(?,?,?,?)
                ON CONFLICT(username) DO UPDATE SET full_name=excluded.full_name,
                updated_at=excluded.updated_at,updated_by=excluded.updated_by""",
                (username, full_name, now(), session["admin_id"]),
            )
        else:
            conn.execute("DELETE FROM user_profiles WHERE username=?", (username,))
    audit(session["admin_id"], "user_profile_updated", username, {
        "previous_full_name": previous["full_name"] if previous else "",
        "full_name": full_name,
    }, _client_ip(request))
    return {"ok": True, "full_name": full_name, "message": "Name or note updated"}


@app.post("/api/actions/{action_id}/approve")
def approve_action(
    action_id: int, request: Request, session: dict[str, Any] = Depends(csrf_admin),
) -> dict[str, Any]:
    with connect() as conn:
        action = conn.execute("SELECT * FROM actions WHERE id=?", (action_id,)).fetchone()
        if not action or action["status"] != "pending":
            raise HTTPException(409, "This request does not exist or has already been handled")
        conn.execute(
            "UPDATE actions SET status='approved',approved_by=?,approved_at=? WHERE id=? AND status='pending'",
            (session["admin_id"], now(), action_id),
        )
    audit(session["admin_id"], "action_approved", f"action:{action_id}", {}, _client_ip(request))
    try:
        result = ansible_service.execute_action(action_id)
    except Exception as exc:
        execute("UPDATE actions SET status='failed',executed_at=?,error=? WHERE id=?", (now(), str(exc), action_id))
        audit(session["admin_id"], "action_failed", f"action:{action_id}", {"error": str(exc)}, _client_ip(request))
        raise HTTPException(500, f"Execution failed: {exc}") from exc
    event = "action_executed" if result.ok else "action_failed"
    audit(session["admin_id"], event, f"action:{action_id}", {"result": result.output[-1000:]}, _client_ip(request))
    if not result.ok:
        raise HTTPException(500, "Remote execution failed. See the request history for details")
    payload = json.loads(action["payload_json"])
    if action["action_type"] == "create_user" and payload.get("full_name", "").strip():
        execute(
            """INSERT INTO user_profiles(username,full_name,updated_at,updated_by) VALUES(?,?,?,?)
            ON CONFLICT(username) DO UPDATE SET full_name=excluded.full_name,
            updated_at=excluded.updated_at,updated_by=excluded.updated_by""",
            (action["target_user"], payload["full_name"].strip(), now(), session["admin_id"]),
        )
    try:
        ansible_service.scan_servers(payload["servers"])
    except Exception:
        pass
    return {"ok": True, "message": "Action completed"}


@app.post("/api/actions/{action_id}/reject")
def reject_action(
    action_id: int, request: Request, session: dict[str, Any] = Depends(csrf_admin),
) -> dict[str, Any]:
    changed = execute(
        "UPDATE actions SET status='rejected',approved_by=?,approved_at=? WHERE id=? AND status='pending'",
        (session["admin_id"], now(), action_id),
    )
    # sqlite lastrowid is not a rowcount, so verify the resulting state.
    action = row("SELECT status FROM actions WHERE id=?", (action_id,))
    if not action or action["status"] != "rejected":
        raise HTTPException(409, "This request does not exist or has already been handled")
    audit(session["admin_id"], "action_rejected", f"action:{action_id}", {}, _client_ip(request))
    return {"ok": True}


@app.post("/api/scan")
def scan(request: Request, session: dict[str, Any] = Depends(csrf_admin)) -> dict[str, Any]:
    audit(session["admin_id"], "scan_started", "all_servers", {}, _client_ip(request))
    try:
        users, errors = ansible_service.scan_servers()
    except Exception as exc:
        audit(session["admin_id"], "scan_failed", "all_servers", {"error": str(exc)}, _client_ip(request))
        raise HTTPException(500, f"Scan failed: {exc}") from exc
    audit(session["admin_id"], "scan_completed", "all_servers", {"users": len(users), "errors": errors}, _client_ip(request))
    return {"ok": not errors, "users": len(users), "errors": errors}


@app.get("/api/actions/{action_id}/private-key")
def download_private_key(
    action_id: int, request: Request, session: dict[str, Any] = Depends(current_admin),
) -> Response:
    # Serialize competing downloads and claim the secret before returning bytes.
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        action_row = conn.execute("SELECT * FROM actions WHERE id=?", (action_id,)).fetchone()
        if not action_row or action_row["action_type"] != "create_user" or action_row["status"] != "executed":
            raise HTTPException(404, "No credentials are available for download")
        if action_row["key_downloaded_at"] or not action_row["private_key_path"]:
            raise HTTPException(410, "Credentials were already downloaded and removed from the manager")
        action = dict(action_row)
        conn.execute(
            "UPDATE actions SET private_key_path=NULL,key_downloaded_at=? WHERE id=?",
            (now(), action_id),
        )
    path = Path(action["private_key_path"])
    try:
        key_bytes = path.read_bytes()
    except FileNotFoundError as exc:
        raise HTTPException(410, "The credentials file no longer exists") from exc
    # Delete before responding so a repeated request cannot retrieve it again.
    path.unlink()
    audit(session["admin_id"], "private_key_downloaded", f"action:{action_id}", {
        "username": action["target_user"], "fingerprint": action["key_fingerprint"],
    }, _client_ip(request))
    headers = {"Content-Disposition": f'attachment; filename="{action["target_user"]}-server-login.zip"'}
    return Response(key_bytes, media_type="application/zip", headers=headers)


@app.post("/api/change-password")
def change_password(
    body: PasswordChangeRequest, request: Request, session: dict[str, Any] = Depends(csrf_admin),
) -> dict[str, Any]:
    if DESKTOP_TOKEN:
        raise HTTPException(404, "The desktop app does not use an administrator password")
    admin = row("SELECT * FROM admins WHERE id=?", (session["admin_id"],))
    if not admin or not verify_password(body.current_password, admin["password_hash"]):
        raise HTTPException(400, "Current password is incorrect")
    execute("UPDATE admins SET password_hash=? WHERE id=?", (hash_password(body.new_password), admin["id"]))
    (DATA_DIR / "initial_admin_password").unlink(missing_ok=True)
    audit(admin["id"], "password_changed", admin["username"], {}, _client_ip(request))
    return {"ok": True}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
