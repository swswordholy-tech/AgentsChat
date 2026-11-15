"""Campaign #130 Python SDK security & protocol boundary parity tests."""
from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentchat import AgentChatClient, AgentChatREST, AgentChatRESTError
from agentchat._security import redact_error, validate_path_segment, validate_server_url, validate_token
from agentchat.client import MAX_WS_MESSAGE_BYTES
from test_sdk import _FakeWebSocket


class Campaign130SecurityParityTests(unittest.TestCase):
    def test_ssrf_metadata_alibaba_aws_ipv6_unspecified_and_subdomain_parity(self) -> None:
        blocked_hosts = [
            "0.0.0.0",
            "[::]",
            "[0:0:0:0:0:0:0:0]",
            "[::ffff:0.0.0.0]",
            "100.100.100.200",
            "[::ffff:100.100.100.200]",
            "[fd00:ec2::254]",
            "metadata",
            "instance-data",
            "sub.metadata.google.internal",
            "compute.metadata.goog",
        ]
        for host in blocked_hosts:
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    AgentChatREST(f"https://{host}")
                with self.assertRaises(ValueError):
                    AgentChatClient(f"wss://{host}/ws", "bot-1")

    def test_path_segment_prototype_encoded_traversal_c1_and_length_caps(self) -> None:
        bad_segments = [
            "__proto__",
            "CONSTRUCTOR",
            "Prototype",
            "room%2fescape",
            "room%5cescape",
            "room%00null",
            "room%2e%2eescape",
            "room\u0085c1",
            "room\u2028sep",
            "x" * 257,
        ]
        for seg in bad_segments:
            with self.subTest(seg=seg):
                with self.assertRaises(ValueError):
                    validate_path_segment(seg, "channel_id")

        # Valid Unicode and # / : identifiers remain intact
        for good in ("dm:a:b", "team-agent#1", "中文#1", "user+tag@example.com", "x" * 256):
            validate_path_segment(good, "channel_id")

    def test_redact_error_expands_glpat_stripe_hf_npm_url_userinfo_and_c1_controls(self) -> None:
        glpat = ("gl" + "pat-") + "1234567890abcdef"
        rk_live = ("rk" + "_live_") + "1234567890abcdef"
        hf_tok = ("hf" + "_") + "1234567890abcdef"
        npm_tok = ("npm" + "_") + "1234567890abcdef"
        sk_under = ("sk" + "_") + "1234567890abcdef"
        raw = f"err https://admin:topSecretPass@127.0.0.1:8080/x {glpat} {rk_live} {hf_tok} {npm_tok} {sk_under}\u0085\u2028"
        cleaned = redact_error(raw)
        for secret in ("topSecretPass", glpat, rk_live, hf_tok, npm_tok, sk_under, "\u0085", "\u2028"):
            self.assertNotIn(secret, cleaned)
        self.assertIn("https://[REDACTED]@127.0.0.1:8080/x", cleaned)

        with self.assertRaises(ValueError):
            validate_token("tok\u0085bad")
        with self.assertRaises(ValueError):
            validate_token("t" * 4097)
        with self.assertRaises(ValueError):
            validate_server_url("https://example.com/" + ("a" * 2050), ("https",))

    def test_rest_webhook_ssrf_own_proto_and_strict_limit_guards(self) -> None:
        rest = AgentChatREST("https://agents-chat.com")
        rest._opener.open = Mock(side_effect=AssertionError("unexpected network call"))

        for bad_hook in (
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://evil.example.com/hook",
            "https://user:pass@agents-chat.com/hook",
            "https://169.254.169.254/latest/meta-data/",
            "https://100.100.100.200/latest/meta-data/",
            "https://[fd00:ec2::254]/latest/",
            "https://0.0.0.0/hook",
            "https://metadata.google.internal/v1",
        ):
            with self.subTest(bad_hook=bad_hook):
                with self.assertRaises(ValueError):
                    rest.register_webhook("room-1", bad_hook)
                with self.assertRaises(ValueError):
                    rest.remove_webhook("room-1", bad_hook)

        for bad_limit in (True, False, 0, -5, 1001, "5&x=1", "abc", 1.5):
            with self.subTest(bad_limit=repr(bad_limit)):
                with self.assertRaises(ValueError):
                    rest.get_messages("room-1", limit=bad_limit)  # type: ignore[arg-type]
                with self.assertRaises(ValueError):
                    rest.discover(limit=bad_limit)  # type: ignore[arg-type]
                with self.assertRaises(ValueError):
                    rest.search("hi", limit=bad_limit)  # type: ignore[arg-type]
                with self.assertRaises(ValueError):
                    rest.discover_channels(limit=bad_limit)  # type: ignore[arg-type]
                with self.assertRaises(ValueError):
                    rest.get_unclaimed_agents(limit=bad_limit)  # type: ignore[arg-type]

        rest._opener.open.assert_not_called()

        # Top-level own "__proto__" JSON payload is rejected as invalid object
        with patch.object(
            rest._opener,
            "open",
            return_value=io.BytesIO(b'{"__proto__":{"polluted":1},"ok":true}'),
        ):
            with self.assertRaises(AgentChatRESTError):
                rest.health()


class Campaign130WebSocketParityTests(unittest.IsolatedAsyncioTestCase):
    async def test_custom_ws_factory_enforces_max_frame_bytes_and_rejects_own_proto(self) -> None:
        # 1. Oversized handshake frame rejected in connect()
        oversized_ws = _FakeWebSocket()
        await oversized_ws.server_to_client.put(
            '{"type":"auth_ok","pad":"' + ("x" * (MAX_WS_MESSAGE_BYTES + 64)) + '"}'
        )
        client = AgentChatClient(
            "ws://localhost:8080/ws",
            "bot-1",
            ws_factory=lambda *_a, **_kw: self._ready_ws(oversized_ws),
        )
        with self.assertRaises(ConnectionError):
            await client.connect()
        self.assertTrue(oversized_ws.closed)

        # 2. Oversized & own-__proto__ midstream frames skipped safely; binary UTF-8 frame decoded cleanly
        stream_ws = _FakeWebSocket()
        await stream_ws.server_to_client.put('{"type":"auth_ok","session_id":"s130"}')
        await stream_ws.server_to_client.put(
            '{"type":"message","id":"big","channel_id":"r","sender_id":"p","content":"'
            + ("y" * (MAX_WS_MESSAGE_BYTES + 64))
            + '"}'
        )
        await stream_ws.server_to_client.put(
            '{"__proto__":{"polluted":1},"type":"message","id":"proto","channel_id":"r","sender_id":"p","content":"bad"}'
        )
        await stream_ws.server_to_client.put(
            json.dumps(
                {
                    "type": "message",
                    "id": "m-bytes",
                    "channel_id": "room-1",
                    "sender_id": "peer-1",
                    "content": "binary utf8 ok",
                    "timestamp": "2026-11-15T02:30:00Z",
                }
            ).encode("utf-8")  # type: ignore[arg-type]
        )
        await stream_ws.server_to_client.put('{"type":"please_reconnect"}')

        client2 = AgentChatClient(
            "ws://localhost:8080/ws",
            "bot-1",
            ws_factory=lambda *_a, **_kw: self._ready_ws(stream_ws),
        )
        await client2.connect()
        received = [m async for m in client2.messages()]
        self.assertEqual([m.id for m in received], ["m-bytes"])

        # 3. create_channel member IDs, propose expires_in_hours, and discover limit bounds
        live_ws = _FakeWebSocket()
        await live_ws.server_to_client.put('{"type":"auth_ok","session_id":"s131"}')
        client3 = AgentChatClient(
            "ws://localhost:8080/ws",
            "bot-1",
            ws_factory=lambda *_a, **_kw: self._ready_ws(live_ws),
        )
        await client3.connect()
        await live_ws.client_to_server.get()  # drain auth frame

        for bad_member in ("../escape", "__proto__", "a/b"):
            with self.assertRaises(ValueError):
                await client3.create_channel("Room", members=["bot-1", bad_member])
        for bad_hours in (float("nan"), float("inf"), 0, -1, 8761, True):
            with self.assertRaises(ValueError):
                await client3.propose("room-1", "Title", "Body", expires_in_hours=bad_hours)  # type: ignore[arg-type]
        for bad_limit in (True, 0, -1, 1001):
            with self.assertRaises(ValueError):
                await client3.discover(limit=bad_limit)  # type: ignore[arg-type]
        await client3.disconnect()

    @staticmethod
    async def _ready_ws(ws: _FakeWebSocket) -> _FakeWebSocket:
        return ws


if __name__ == "__main__":
    unittest.main()
