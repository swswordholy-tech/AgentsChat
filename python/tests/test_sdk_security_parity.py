"""SDK security parity regressions; transports stay in memory or on loopback."""
import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentchat import AgentChatClient, AgentChatREST, AgentChatRESTError, ChannelRole
from agentchat._security import redact_error

CONTROLS = [chr(n) for n in range(32)] + ['\x7f']
SECRETS = ['mcp_at_private', 'mcp_rt_private', 'mcp_code_private', 'agent_key_private', 'whsec_private',
           *[f'gh{c}_private' for c in 'pousr'], 'github_pat_private', *[f'xox{c}-private' for c in 'baprs'],
           'AIzaPrivate123456789', 'AKIA1234567890ABCDEF', 'ASIA1234567890ABCDEF']
HOSTS = ['metadata.google.internal', 'METADATA.GOOGLE.INTERNAL.', 'metadata.goog', 'metadata.goog.',
         '169.254.0.1', '169.254.255.255', '0xa9fea9fe', '2852039166', '0251.0376.0251.0376', '169.16689662',
         '[fe80::1]', '[febf:ffff::1]', '[::ffff:169.254.169.254]', '[::ffff:0:169.254.169.254]',
         '[::ffff:a9fe:a9fe]', '[0:0:0:0:ffff:0:a9fe:a9fe]', '[::169.254.169.254]']
BAD_IDS = ['', ' ', '.', '..', ' . ', ' .. ', 'a/b', 'a\\b', *[f'{c}room{c}' for c in CONTROLS]]


class SecurityParityTests(unittest.TestCase):
    def test_redaction_families_basic_controls_and_ordinary_text(self):
        for secret in SECRETS:
            with self.subTest(secret=secret):
                self.assertEqual(redact_error(f'failure {secret} after'), 'failure [REDACTED] after')
        self.assertEqual(redact_error('Basic dXNlcjpwYXNz Bearer private ' + ''.join(CONTROLS)),
                         'Basic [REDACTED] Bearer [REDACTED] ')
        self.assertEqual(redact_error('中文 room-asia-pacific aiza-guide sk-short'), '中文 room-asia-pacific aiza-guide sk-short')

    def test_metadata_and_linklocal_canonical_hosts(self):
        for host in HOSTS:
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    AgentChatREST(f'https://{host}')
                with self.assertRaises(ValueError):
                    AgentChatClient(f'wss://{host}/ws', 'bot')

    def test_zero_port_and_valid_host_boundaries(self):
        for port in ('0', '000'):
            with self.assertRaises(ValueError):
                AgentChatREST(f'http://localhost:{port}')
            with self.assertRaises(ValueError):
                AgentChatClient(f'ws://localhost:{port}', 'bot')
        for host in ('metadata.goog.example', '169.253.1.1', '169.255.1.1', '[fe7f::1]', '[fec0::1]', '[::ffff:192.168.1.1]'):
            self.assertIsNotNone(AgentChatREST(f'https://{host}'))
            self.assertIsNotNone(AgentChatClient(f'wss://{host}', 'bot'))

    def test_rest_path_query_and_body_ids_reject_before_io(self):
        c = AgentChatREST('https://example.com')
        c._opener.open = Mock(side_effect=AssertionError('unexpected transport'))
        for value in BAD_IDS:
            for request in [lambda: c.get_agent(value), lambda: c.get_account(value), lambda: c.get_messages(value),
                            lambda: c.get_messages('room', before=value), lambda: c.get_channels(value),
                            lambda: c.send_message('room', value, 'body'), lambda: c.release_agent('owner', value),
                            lambda: c.search('query', channel_id=value), lambda: c.my_channels(value)]:
                with self.subTest(value=repr(value), request=request):
                    with self.assertRaises(ValueError):
                        request()
        c._opener.open.assert_not_called()

    def test_valid_dm_paths_and_unicode_encoding_retain_auth(self):
        c = AgentChatREST('https://example.com/prefix', token='private')
        calls = []
        def opened(req, **kwargs):
            calls.append(req)
            return io.BytesIO(b'{"messages":[]}')
        c._opener.open = opened
        for channel in ('dm:a:b', 'dm-a-b', '中文#1'):
            self.assertEqual(c.get_messages(channel), [])
        self.assertIn('/dm%3Aa%3Ab/messages', calls[0].full_url)
        self.assertIn('/dm-a-b/messages', calls[1].full_url)
        self.assertIn('/%E4%B8%AD%E6%96%87%231/messages', calls[2].full_url)
        for req in calls:
            self.assertEqual(req.get_header('Authorization'), 'Bearer private')


class SocketSecurityParityTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_routing_ids_never_send(self):
        c = AgentChatClient('wss://example.com', 'bot')
        frames = []
        class Socket:
            async def send(self, raw):
                frames.append(json.loads(raw))
        c._ws = Socket()
        for value in BAD_IDS:
            for send in [lambda: c.join_channel(value), lambda: c.pin('room', value),
                         lambda: c.forward('room', value, 'message'), lambda: c.mark_read('room', value),
                         lambda: c.set_role('room', value, ChannelRole.MEMBER)]:
                with self.assertRaises(ValueError):
                    await send()
            with self.assertRaises(ValueError):
                AgentChatClient('wss://example.com', value)
        self.assertEqual(frames, [])
        for channel in ('dm:a:b', 'dm-a-b'):
            await c.join_channel(channel)
        self.assertEqual([f['channel_id'] for f in frames], ['dm:a:b', 'dm-a-b'])


if __name__ == '__main__':
    unittest.main()
