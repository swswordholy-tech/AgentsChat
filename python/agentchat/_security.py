"""Keep credentials out of diagnostic text (never applied to message content)."""

import ipaddress
import re
import socket
from urllib.parse import urlsplit


PROTOTYPE_KEYS = frozenset({"__proto__", "constructor", "prototype"})
PRE_ENCODED_TRAVERSAL_RE = re.compile(r"%(?:2e%2e|2f|5c|00)", re.I)


def _has_control_chars(value: str) -> bool:
    return any(
        ord(c) < 32 or 0x7F <= ord(c) <= 0x9F or c in ("\u2028", "\u2029")
        for c in value
    )


def redact_error(value: object, token: str | None = None) -> str:
    text = str(value)
    if token:
        text = re.sub(r"(?<![A-Za-z0-9_-])" + re.escape(token) + r"(?![A-Za-z0-9_-])", "[REDACTED]", text)
    text = re.sub(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s@]+@", r"\1[REDACTED]@", text)
    text = re.sub(r"ac_[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"sk[-_][A-Za-z0-9_-]{12,}", "[REDACTED]", text)
    text = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(
        r"(?:mcp_(?:at|rt|code)_|agent_key_|whsec_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_)[A-Za-z0-9_-]+",
        "[REDACTED]",
        text,
        flags=re.I,
    )
    text = re.sub(r"AIza[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])", "[REDACTED]", text)
    text = re.sub(r"(?i)\b(Bearer|Basic)\s+[^\s\"'<>]+", r"\1 [REDACTED]", text)
    return re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", "", text)


def validate_token(token: str | None) -> None:
    if token is not None and (
        not isinstance(token, str) or len(token) > 4096 or _has_control_chars(token)
    ):
        raise ValueError("token must not contain control characters")


def validate_server_url(url: str, schemes: tuple[str, ...], *, loopback_http: bool = False, allow_query: bool = False) -> None:
    try:
        if (
            not isinstance(url, str)
            or not url
            or len(url) > 2048
            or url != url.strip()
            or _has_control_chars(url)
        ):
            raise ValueError
        parts = urlsplit(url)
        if parts.scheme not in schemes or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError
        # Reject metadata & unspecified literals before opening any authenticated connection.
        if parts.port == 0 or _metadata_host(parts.hostname):
            raise ValueError
        if (parts.query and not allow_query) or parts.fragment:
            raise ValueError
        if loopback_http and parts.scheme == "http" and parts.hostname.lower() != "localhost":
            if not ipaddress.ip_address(parts.hostname).is_loopback:
                raise ValueError
    except ValueError:
        raise ValueError("Invalid server URL") from None


def _metadata_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    if (
        host in ("metadata.google.internal", "metadata.goog", "metadata", "instance-data")
        or host.endswith(".metadata.google.internal")
        or host.endswith(".metadata.goog")
    ):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            # inet_aton accepts the decimal, octal, hex and shortened IPv4
            # forms accepted by socket transports, without performing DNS.
            address = ipaddress.ip_address(socket.inet_aton(host))
        except (OSError, ValueError):
            return False
    if address.is_unspecified:
        return True
    if address.version == 4:
        return (
            address in ipaddress.ip_network("169.254.0.0/16")
            or address == ipaddress.IPv4Address("100.100.100.200")
        )
    if address in ipaddress.ip_network("fe80::/10") or address == ipaddress.IPv6Address("fd00:ec2::254"):
        return True
    if any(address in ipaddress.ip_network(prefix) for prefix in
           ("::/96", "::ffff:0:0/96", "::ffff:0:0:0/96")):
        mapped = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        return (
            mapped.is_unspecified
            or mapped in ipaddress.ip_network("169.254.0.0/16")
            or mapped == ipaddress.IPv4Address("100.100.100.200")
        )
    return False


def validate_path_segment(value: object, name: str = "path segment") -> None:
    if (
        not isinstance(value, str)
        or len(value) > 256
        or not value.strip()
        or value.strip() in (".", "..")
        or value.strip().lower() in PROTOTYPE_KEYS
        or _has_control_chars(value)
        or re.search(r"[/\\]", value)
        or PRE_ENCODED_TRAVERSAL_RE.search(value)
    ):
        raise ValueError(f"Invalid {name}")
