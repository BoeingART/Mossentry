from __future__ import annotations

import re
import ipaddress
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    servers: list[str] = Field(min_length=1)
    sudo: bool = False
    full_name: str = ""

    @field_validator("username")
    @classmethod
    def valid_username(cls, value: str) -> str:
        if not USERNAME_RE.fullmatch(value):
            raise ValueError("Username must use lowercase letters, digits, underscores, or hyphens and be at most 32 characters")
        return value


class UserActionRequest(BaseModel):
    username: str
    servers: list[str] = Field(min_length=1)
    action: Literal["disable_user", "enable_user", "set_sudo", "delete_user"]
    sudo: bool | None = None

    @field_validator("username")
    @classmethod
    def valid_username(cls, value: str) -> str:
        if not USERNAME_RE.fullmatch(value):
            raise ValueError("Invalid username")
        return value


class UserProfileUpdate(BaseModel):
    full_name: str = Field(default="", max_length=100)


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12)


class ServerRequest(BaseModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,31}$")
    hostname: str = Field(min_length=1, max_length=253)
    port: int = Field(default=22, ge=1, le=65535)
    ssh_user: str = Field(pattern=r"^[a-z_][a-z0-9_-]{0,31}$")
    key_path: str = Field(default_factory=lambda: str(Path("~/.ssh/id_rsa").expanduser()), min_length=1, max_length=1024)
    enabled: bool = True

    @field_validator("hostname")
    @classmethod
    def valid_host(cls, value: str) -> str:
        value = value.strip()
        try:
            ipaddress.ip_address(value)
        except ValueError:
            if not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                       for label in value.rstrip(".").split(".")):
                raise ValueError("Enter a hostname or IP address without a protocol or port")
        return value

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if value in {"all", "ungrouped", "managed"}:
            raise ValueError("This server name is reserved")
        return value

    @field_validator("key_path")
    @classmethod
    def valid_key_path(cls, value: str) -> str:
        if any(ord(char) < 32 for char in value):
            raise ValueError("Invalid SSH key path")
        path = Path(value.strip()).expanduser()
        if not path.is_absolute():
            raise ValueError("Use an absolute SSH key path or a path starting with ~/")
        return str(path)
