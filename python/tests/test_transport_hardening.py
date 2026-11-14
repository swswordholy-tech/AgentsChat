"""Transport boundary regressions using loopback HTTP and deterministic sockets."""
import asyncio
import io
import json
import sys
import threading
import traceback
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentchat import AgentChatClient, AgentChatREST, AgentChatRESTError
from agentchat._security import redact_error
from test_sdk import _FakeWebSocket


class _Target(BaseHTTPRequestHandler):
    hits = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        type(self).hits.append(self.headers.get('Authorization'))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')

    do_POST = do_GET


class _Source(_Target):
    target = ''

    def do_GET(self):
        if self.path.startswith('/redirect/'):
            code = int(self.path.split('/')[2])
            self.send_response(code)
            self.send_header('Location', self.target + '/credential-sink')
            self.end_headers()
            return
        if self.path == '/same-origin':
            self.send_response(302)
            self.send_header('Location', '/credential-sink')
            self.end_headers()
            return
        bodies = {'/invalid-utf8': b'\xff', '/invalid-json': b'{broken', '/array': b'[]', '/null': b'null'}
        self.send_response(200)
        self.end_headers()
        self.wfile.write(bodies.get(self.path, b'{"agents":[],"channels":[],"messages":[]}'))

    do_POST = do_GET


class RESTTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.target = ThreadingHTTPServer(('127.0.0.1', 0), _Target)
        _Source.target = f'http://127.0.0.1:{cls.target.server_port}'
        cls.source = ThreadingHTTPServer(('127.0.0.1', 0), _Source)
        cls.threads = []
        for server in (cls.target, cls.source):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)
        cls.base = f'http://127.0.0.1:{cls.source.server_port}'

    @classmethod
    def tearDownClass(cls):
        for server in (cls.source, cls.target):
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join(timeout=2)

    def test_redirects_never_reach_cross_origin_with_credentials(self):
        _Target.hits = []
        rest = AgentChatREST(self.base, token='private-token')
        for code in (301, 302, 303, 307, 308):
            for method in ('GET', 'POST'):
                with self.subTest(code=code, method=method):
                    with self.assertRaises(AgentChatRESTError) as ctx:
                        rest._request(method, f'/redirect/{code}', {} if method == 'POST' else None)
                    self.assertEqual(ctx.exception.status, code)
                    self.assertEqual(ctx.exception.message, 'Unexpected HTTP redirect')
        self.assertEqual(_Target.hits, [])

    def test_same_origin_redirect_also_rejected(self):
        with self.assertRaisesRegex(AgentChatRESTError, 'Unexpected HTTP redirect'):
            AgentChatREST(self.base)._get('/same-origin')

    def test_redirect_response_closed(self):
        from agentchat.rest import _RejectRedirects
        body = io.BytesIO(b'ignored')
        with self.assertRaises(AgentChatRESTError):
            _RejectRedirects().http_error_302(None, body, 302, 'Found', {})
        self.assertTrue(body.closed)

    def test_invalid_json_utf8_and_non_object_responses_are_sdk_errors(self):
        for path in ('/invalid-utf8', '/invalid-json', '/array', '/null'):
            with self.subTest(path=path), self.assertRaises(AgentChatRESTError) as ctx:
                AgentChatREST(self.base)._get(path)
            self.assertEqual(ctx.exception.status, 0)
            self.assertNotIn('UnicodeDecodeError', ''.join(traceback.format_exception(ctx.exception)))

    def test_rest_url_rejects_unsafe_protocols_credentials_and_remote_plaintext(self):
        for url in ('file:///etc/passwd', 'ftp://example.com', 'http://example.com',
                    'https://user:secret@example.com', 'https://user@example.com',
                    'https://', 'https://example.com:bad', 'https://example.com:99999',
                    'https://example.com\r\nInjected: secret', ' https://example.com',
                    'https://example.com?x=1', 'https://example.com#fragment'):
            with self.subTest(url=url), self.assertRaises(ValueError) as ctx:
                AgentChatREST(url)
            self.assertNotIn('secret', str(ctx.exception))

    def test_rest_accepts_https_and_loopback_forms(self):
        for url in ('https://example.com', 'http://localhost:8080/', 'http://127.0.0.1',
                    'http://127.1.2.3', 'http://[::1]:8080'):
            AgentChatREST(url)

    def test_tokens_reject_all_header_controls_for_both_transports(self):
        for code in (*range(32), 127):
            for factory in (lambda token: AgentChatREST(self.base, token=token),
                            lambda token: AgentChatClient('ws://localhost', 'bot', token)):
                with self.subTest(code=code), self.assertRaises(ValueError):
                    factory('secret' + chr(code) + 'suffix')

    def test_all_collection_endpoints_reject_non_object_or_invalid_list(self):
        rest = AgentChatREST(self.base)
        endpoints = ((rest.get_online_agents, (), 'agents'), (rest.discover, (), 'agents'),
                     (rest.get_unclaimed_agents, (), 'agents'), (rest.get_channels, ('bot',), 'channels'),
                     (rest.get_messages, ('room',), 'messages'), (rest.search, ('q',), 'messages'),
                     (rest.discover_channels, (), 'channels'), (rest.my_channels, ('bot',), 'channels'))
        for call, args, key in endpoints:
            for data in ([], None, 'text', {key: None}, {key: {}}):
                with self.subTest(endpoint=call.__name__, data=data), patch.object(rest, '_get', return_value=data):
                    with self.assertRaises(AgentChatRESTError):
                        call(*args)
        with patch.object(rest, '_get', return_value={}):
            self.assertEqual(rest.discover_channels(), [])
            self.assertEqual(rest.my_channels('bot'), [])

    def test_unclaimed_limit_normalized_and_injection_rejected_before_io(self):
        rest = AgentChatREST(self.base)
        with patch.object(rest, '_get', return_value={'agents': []}) as get:
            rest.get_unclaimed_agents('007')
            get.assert_called_once_with('/api/agents/unclaimed?limit=7')
            get.reset_mock()
            with self.assertRaises(ValueError):
                rest.get_unclaimed_agents('5&token=secret')
            get.assert_not_called()

    def test_redaction_adds_openai_keys_and_jwt_without_altering_plain_text(self):
        secrets = ('sk-' + 'aB_9-' * 3, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib3QifQ.signature')
        rendered = redact_error('error: ' + ' '.join(secrets) + ' ac_other Bearer private-token', 'private-token')
        for secret in (*secrets, 'ac_other', 'private-token'):
            self.assertNotIn(secret, rendered)
        self.assertEqual(redact_error('ordinary 中文 diagnostic sk-short'), 'ordinary 中文 diagnostic sk-short')


class WebSocketTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_connect_closes_previous_socket_before_factory(self):
        sockets = [_FakeWebSocket(), _FakeWebSocket()]
        for i, ws in enumerate(sockets):
            await ws.server_to_client.put(json.dumps({'type': 'auth_ok', 'session_id': str(i)}))
        calls = 0
        async def factory(*args, **kwargs):
            nonlocal calls
            if calls:
                self.assertTrue(sockets[0].closed)
                self.assertIsNone(client._session_id)
                self.assertFalse(client._running)
            ws = sockets[calls]
            calls += 1
            return ws
        client = AgentChatClient('ws://localhost', 'bot', ws_factory=factory)
        await client.connect()
        await client.connect()
        self.assertIs(client._ws, sockets[1])
        self.assertEqual(client._session_id, '1')
        await client.disconnect()
        self.assertTrue(all(ws.closed for ws in sockets))

    async def test_failed_reconnect_leaves_no_old_session_or_socket(self):
        ws = _FakeWebSocket()
        await ws.server_to_client.put('{"type":"auth_ok","session_id":"old"}')
        async def factory(*args, **kwargs):
            if ws.closed:
                raise OSError('sk-abcdefghijklmnop')
            return ws
        client = AgentChatClient('wss://example.com/ws', 'bot', ws_factory=factory)
        await client.connect()
        with self.assertRaises(ConnectionError) as ctx:
            await client.connect()
        self.assertNotIn('sk-abcdefghijklmnop', str(ctx.exception))
        self.assertTrue(ws.closed)
        self.assertIsNone(client._ws)
        self.assertIsNone(client._session_id)
        self.assertFalse(client._running)

    async def test_websocket_url_and_agent_validation(self):
        for url in ('http://localhost', 'file:///tmp/socket', 'ws://user:secret@localhost',
                    'wss://user@localhost', 'ws://', 'ws://localhost\n', 'ws://localhost:bad'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                AgentChatClient(url, 'bot')
        for agent_id in ('', '   ', None):
            with self.subTest(agent_id=agent_id), self.assertRaises(ValueError):
                AgentChatClient('ws://localhost', agent_id)

    async def test_websocket_query_parameters_remain_supported(self):
        client = AgentChatClient('wss://example.com/ws?client=python', 'bot')
        self.assertEqual(client.url, 'wss://example.com/ws?client=python')

    async def test_message_queue_is_bounded(self):
        client = AgentChatClient('ws://localhost', 'bot')
        for i in range(1000):
            client._message_queue.put_nowait(i)
        with self.assertRaises(asyncio.QueueFull):
            client._message_queue.put_nowait('overflow')
