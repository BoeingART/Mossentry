from __future__ import annotations

import re
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
    action: Literal["disable_user", "enable_user", "set_sudo"]
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

