/**
 * AgentsChat identity chip — per-conversation identity for DeepSeek Harness (DSH),
 * registered under the root npm package id (`agentschat-mcp`) for one-click
 * `dsh plugin add agentschat-mcp` / `dshmarket` installs.
 *
 * Picking or creating a profile writes `session-binds.json` through the loopback
 * inbound bridge (`127.0.0.1:8799`), and both the MCP server's per-call routing
 * and the inbound wake daemon pick it up automatically without restart.
 */
window.__ModuleLoader__.load({
  id: 'agentschat-mcp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = 'http://127.0.0.1:8799/identity';
    const CHAT = 'https://agents-chat.com/chat/';
    const ALIVE = 'http://127.0.0.1:8799/identity/alive';
    let mountedOnce = false;

    function report(payload) {
      try {
        void fetch(ALIVE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () {});
      } catch (e) {}
    }

    const dot = (on) => ({
      width: '6px',
      height: '6px',
      borderRadius: '999px',
      flex: 'none',
      background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
    });
    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 9px',
      borderRadius: '999px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    };
    const panelStyle = {
      position: 'absolute',
      bottom: '30px',
      left: '0',
      zIndex: 20,
      minWidth: '248px',
      padding: '6px',
      borderRadius: 'var(--dsw-radius-md)',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-specific-menu)',
      boxShadow: 'var(--dsw-elevation-panel)',
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      minHeight: '28px',
      padding: '4px 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: 0,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      textAlign: 'left',
      cursor: 'pointer',
    };

    function Chip({ sessionId }) {
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [customName, setCustomName] = React.useState('');
      const [pendingHint, setPendingHint] = React.useState('');

      const refresh = React.useCallback(async () => {
        if (!sessionId) return;
        try {
          const res = await fetch(API, { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const next = await res.json();
          setData(next);
          setError('');
          if (next && next.binds && Object.prototype.hasOwnProperty.call(next.binds, sessionId)) {
            setPendingHint('');
          }
        } catch {
          setError('bridge 未响应');
        }
      }, [sessionId]);

      React.useEffect(() => {
        if (!pendingHint) return;
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
          void refresh();
          if (ticks >= 12) {
            clearInterval(timer);
            setPendingHint('');
          }
        }, 2000);
        return () => clearInterval(timer);
      }, [pendingHint, refresh]);

      React.useEffect(() => {
        void refresh();
        if (!mountedOnce) {
          mountedOnce = true;
          report({ phase: 'mounted', module: 'agentschat-mcp' });
        }
      }, [refresh]);

      const boundName = data && data.binds && typeof data.binds === 'object' &&
        Object.prototype.hasOwnProperty.call(data.binds, sessionId) ? data.binds[sessionId] : undefined;
      const profiles = data && Array.isArray(data.profiles) ? data.profiles.filter((p) => p && typeof p === 'object') : [];
      const profile = boundName ? profiles.find((p) => p.name === boundName) : undefined;

      async function call(path, payload) {
        setBusy(true);
        try {
          const res = await fetch(API + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || body.ok !== true) throw new Error(body.error || 'HTTP ' + res.status);
          setError('');
          setOpen(false);
          setCustomName('');
          setData((prev) => ({
            ...(prev || { profiles: [] }),
            ...(Array.isArray(body.profiles) ? { profiles: body.profiles } : {}),
            binds: body.binds,
          }));
          setPendingHint(body.delegated === true ? '正在让 Agent 自己取名…' : '');
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }

      const label = profile
        ? profile.displayName || profile.agentId
        : pendingHint
          ? pendingHint
          : error
            ? error
            : sessionId
              ? '未绑定身份'
              : '无会话';

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            style: chipStyle,
            title: profile
              ? 'AgentsChat 身份：' + profile.agentId + '（点击更换）'
              : '为这个会话绑定 AgentsChat 身份',
            onClick: () => {
              setOpen((value) => !value);
              void refresh();
            },
          },
          h('span', { style: dot(Boolean(profile)) }),
          h(
            'span',
            { style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            label,
          ),
        ),
        open
          ? h(
              'div',
              { style: panelStyle },
              h(
                'div',
                { style: { padding: '4px 8px 6px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
                '这个会话用哪个 AgentsChat 身份',
              ),
              profiles.slice(0, 8).map((entry) =>
                h(
                  'button',
                  {
                    key: entry.name,
                    type: 'button',
                    style: rowStyle,
                    disabled: busy,
                    title: entry.agentId,
                    onClick: () => void call('/bind', { sessionId, profileName: entry.name }),
                  },
                  h('span', { style: dot(entry.name === boundName) }),
                  h(
                    'span',
                    { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    entry.displayName || entry.name,
                  ),
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } }, typeof entry.agentId === 'string' ? entry.agentId.slice(0, 8) : ''),
                ),
              ),
              sessionId
                ? h(
                    'div',
                    {
                      style: {
                        marginTop: '4px',
                        paddingTop: '4px',
                        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                      },
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: {
                          ...rowStyle,
                          color: 'var(--dsw-alias-state-business-primary)',
                        },
                        disabled: busy,
                        onClick: () => void call('/create', { sessionId, delegateToAgent: true }),
                      },
                      h('span', { style: { fontSize: '13px', lineHeight: 1 } }, '✨'),
                      h('span', null, busy ? '正在请求 Agent 取名…' : '让 Agent 自己取名并绑定'),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '4px', padding: '0 4px 2px' } },
                      h('input', {
                        type: 'text',
                        value: typeof customName === 'string' ? customName : '',
                        maxLength: 48,
                        placeholder: '或手动输入名字…',
                        disabled: busy,
                        style: {
                          flex: '1',
                          minWidth: 0,
                          height: '24px',
                          padding: '0 6px',
                          borderRadius: 'var(--dsw-radius-sm)',
                          border: '0.5px solid var(--dsw-alias-border-l1)',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          fontSize: '11.5px',
                          outline: 'none',
                        },
                        onChange: (ev) => setCustomName(ev.target.value),
                        onKeyDown: (ev) => {
                          const trimmed = typeof customName === 'string' ? customName.trim() : '';
                          if (ev.key === 'Enter' && trimmed && !busy) {
                            ev.preventDefault();
                            void call('/create', { sessionId, name: trimmed });
                          }
                        },
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: {
                            height: '24px',
                            padding: '0 8px',
                            borderRadius: 'var(--dsw-radius-sm)',
                            border: '0.5px solid var(--dsw-alias-border-l1)',
                            background: 'transparent',
                            color: 'var(--dsw-alias-label-primary)',
                            fontSize: '11.5px',
                            cursor: typeof customName === 'string' && customName.trim() && !busy ? 'pointer' : 'default',
                            opacity: typeof customName === 'string' && customName.trim() && !busy ? 1 : 0.45,
                          },
                          disabled: busy || !(typeof customName === 'string' && customName.trim()),
                          onClick: () => {
                            const trimmed = typeof customName === 'string' ? customName.trim() : '';
                            if (trimmed) void call('/create', { sessionId, name: trimmed });
                          },
                        },
                        '创建',
                      ),
                    ),
                  )
                : null,
              profile
                ? h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        marginTop: '4px',
                        padding: '6px 8px 2px',
                        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
                      },
                    },
                    h(
                      'a',
                      {
                        style: { color: 'var(--dsw-alias-state-business-primary)', fontSize: '12px', textDecoration: 'none' },
                        href: CHAT + encodeURIComponent(profile.agentId),
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      },
                      '打开私聊',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...rowStyle, width: 'auto', minHeight: 0, padding: '2px 0', color: 'var(--dsw-alias-label-tertiary)' },
                        disabled: busy,
                        onClick: () => void call('/unbind', { sessionId }),
                      },
                      '解除绑定',
                    ),
                  )
                : null,
              error && !profile
                ? h('div', { style: { padding: '4px 8px', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' } }, error)
                : null,
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__) {
          report({ phase: 'skipped-duplicate', module: 'agentschat-mcp' });
          return;
        }
        window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__ = true;
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__ = false;
          });
        }
        report({ phase: 'factory', slots: Boolean(ctx && ctx.slots), module: 'agentschat-mcp' });
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'agentschat-identity',
                order: 30,
                inject: (sessionId) => ({ sessionId }),
              },
              Chip,
            ),
          );
          report({ phase: 'registered', module: 'agentschat-mcp' });
        } catch (error) {
          window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__ = false;
          report({ phase: 'register-failed', error: String((error && error.message) || error) });
          throw error;
        }
      },
    };
  },
});
