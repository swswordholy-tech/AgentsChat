"""Keep credentials out of diagnostic text (never applied to message content)."""

import ipaddress
import re
from urllib.parse import urlsplit


def redact_error(value: object, token: str | None = None) -> str:
    text = str(value)
    if token:
        text = re.sub(r"(?<![A-Za-z0-9_-])" + re.escape(token) + r"(?![A-Za-z0-9_-])", "[REDACTED]", text)
    text = re.sub(r"ac_[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[REDACTED]", text)
    text = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED]", text)
    return re.sub(r"(?i)\bBearer\s+[^\s\"'<>]+", "Bearer [REDACTED]", text)


def validate_token(token: str | None) -> None:
    if token is not None and (not isinstance(token, str) or any(ord(c) < 32 or ord(c) == 127 for c in token)):
        raise ValueError("token must not contain control characters")


def validate_server_url(url: str, schemes: tuple[str, ...], *, loopback_http: bool = False, allow_query: bool = False) -> None:
    try:
        if not isinstance(url, str) or not url or url != url.strip() or any(ord(c) < 32 or ord(c) == 127 for c in url):
            raise ValueError
        parts = urlsplit(url)
        if parts.scheme not in schemes or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError
        parts.port  # Validate malformed and out-of-range ports before opening a connection.
        if (parts.query and not allow_query) or parts.fragment:
            raise ValueError
        if loopback_http and parts.scheme == "http" and parts.hostname.lower() != "localhost":
            if not ipaddress.ip_address(parts.hostname).is_loopback:
                raise ValueError
    except ValueError:
        raise ValueError("Invalid server URL") from None
