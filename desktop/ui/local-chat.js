(function () {
  "use strict";

  const bridge = window.agentschatLocalBridge || null;
  const originUrl = window.location.origin;
  const wsOriginUrl = originUrl.replace(/^http/i, "ws") + "/ws";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Restore saved theme (default = WeChat crisp Light mode)
  try {
    if (localStorage.getItem("ac_desktop_theme") === "dark") {
      document.body.classList.add("dark");
    }
  } catch {}

  let authToken = sessionStorage.getItem("ac_local_token") || "";
  let currentPrincipal = null;
  let channels = [];
  let currentChannelId = "welcome";
  let currentMembers = [];
  let messages = [];
  let hasMoreOlder = false;
  let loadingOlder = false;
  let activeSearchQuery = "";
  let replyTarget = null;
  let unreadByChannel = new Map();
  let mentionCandidates = [];
  let mentionActiveIdx = 0;
  let ws = null;
  let wsReconnectDelayMs = 1000;
  let wsReconnectTimer = null;

  const elServerPill = document.getElementById("server-url-pill");
  const elIdentityCard = document.getElementById("identity-card");
  const elAuthDot = document.getElementById("auth-dot");
  const elAuthName = document.getElementById("auth-name");
  const elAuthId = document.getElementById("auth-id-text");
  const elChannelList = document.getElementById("channel-list");
  const elBots = document.getElementById("discovered-bots");
  const elRoomTitle = document.getElementById("room-title");
  const elRoomTopic = document.getElementById("room-topic");
  const elMemberStrip = document.getElementById("member-strip");
  const elMessages = document.getElementById("messages-box");
  const elTyping = document.getElementById("typing-bar");
  const elInput = document.getElementById("msg-input");
  const elToast = document.getElementById("toast");
  const elWsPill = document.getElementById("ws-pill");
  const elSearchInput = document.getElementById("search-input");
  const elSearchBanner = document.getElementById("search-banner");
  const elSearchBannerText = document.getElementById("search-banner-text");
  const elReplyBanner = document.getElementById("reply-banner");
  const elReplyBannerText = document.getElementById("reply-banner-text");
  const elMentionMenu = document.getElementById("mention-menu");
  const elScrollBtn = document.getElementById("btn-scroll-bottom");
  const elScrollBtnText = document.getElementById("scroll-bottom-text");

  let pendingNewInRoom = 0;

  function isNearBottom() {
    if (!elMessages) return true;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 96;
  }

  function updateScrollPill() {
    if (!elScrollBtn || !elScrollBtnText) return;
    if (isNearBottom()) {
      pendingNewInRoom = 0;
      elScrollBtn.hidden = true;
      return;
    }
    if (pendingNewInRoom > 0) {
      elScrollBtnText.textContent = `${pendingNewInRoom} 条新消息`;
      elScrollBtn.hidden = false;
    } else if (elMessages.scrollHeight - elMessages.clientHeight > 280) {
      elScrollBtnText.textContent = "回到底部";
      elScrollBtn.hidden = false;
    } else {
      elScrollBtn.hidden = true;
    }
  }

  function applyLocalTheme(theme) {
    const isDark = theme === "dark";
    document.body.classList.toggle("dark", isDark);
    try { localStorage.setItem("ac_desktop_theme", isDark ? "dark" : "light"); } catch {}
  }

  elServerPill.textContent = originUrl.replace(/^https?:\/\//, "");

  // Pure-DOM SVG Icon Factory (zero markup string sinks)
  const ICON_PATHS = {
    hash: [
      ["path", { d: "M4 9h16" }],
      ["path", { d: "M4 15h16" }],
      ["path", { d: "M10 3 8 21" }],
      ["path", { d: "M16 3l-2 18" }],
    ],
    lock: [
      ["rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }],
      ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }],
    ],
    dm: [
      ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }],
    ],
    reply: [
      ["path", { d: "M9 17 4 12l5-5" }],
      ["path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" }],
    ],
    edit: [
      ["path", { d: "M12 20h9" }],
      ["path", { d: "M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" }],
    ],
    trash: [
      ["path", { d: "M3 6h18" }],
      ["path", { d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" }],
      ["path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }],
    ],
    copy: [
      ["rect", { x: "9", y: "9", width: "11", height: "11", rx: "2.2" }],
      ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }],
    ],
    chat: [
      ["path", { d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" }],
    ],
    shield: [
      ["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" }],
    ],
  };

  function createSvgIcon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const defs = ICON_PATHS[name] || [];
    for (const [tag, attrs] of defs) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      svg.appendChild(el);
    }
    return svg;
  }

  // Friendly, vibrant WeChat-like avatar palette (clean readable white initials)
  const AVATAR_SWATCHES = [
    "#07c160",
    "#2b7fff",
    "#ff8c2e",
    "#6366f1",
    "#0ea5a4",
    "#e85d75",
    "#8b5cf6",
    "#3b82f6",
  ];
  function avatarBg(seed) {
    const str = String(seed || "agent");
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return AVATAR_SWATCHES[Math.abs(h) % AVATAR_SWATCHES.length];
  }

  function avatarInitials(name, id) {
    const src = String(name || id || "?").trim();
    if (!src) return "?";
    const parts = src.split(/[\s_-]+/).filter(Boolean);
    if (parts.length >= 2 && /^[A-Za-z0-9]/.test(parts[0]) && /^[A-Za-z0-9]/.test(parts[1])) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return src.slice(0, 2).toUpperCase();
  }

  function showToast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { elToast.hidden = true; }, 2600);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (authToken) headers.Authorization = "Bearer " + authToken;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function openPromptDialog({ title, hint, placeholder1, placeholder2, value1 }) {
    const dlg = document.getElementById("prompt-dialog");
    const i1 = document.getElementById("dialog-input-1");
    const i2 = document.getElementById("dialog-input-2");
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-hint").textContent = hint || "";
    i1.value = value1 || "";
    i1.placeholder = placeholder1 || "";
    if (placeholder2) {
      i2.style.display = "block";
      i2.value = "";
      i2.placeholder = placeholder2;
    } else {
      i2.style.display = "none";
    }
    return new Promise((resolve) => {
      const form = document.getElementById("dialog-form");
      const cancelBtn = document.getElementById("dialog-cancel");
      const cleanup = () => {
        form.removeEventListener("submit", onSubmit);
        cancelBtn.removeEventListener("click", onCancel);
      };
      const onSubmit = (ev) => {
        ev.preventDefault();
        cleanup();
        dlg.close();
        resolve({ v1: i1.value.trim(), v2: i2.value.trim() });
      };
      const onCancel = () => {
        cleanup();
        dlg.close();
        resolve(null);
      };
      form.addEventListener("submit", onSubmit);
      cancelBtn.addEventListener("click", onCancel);
      dlg.showModal();
      i1.focus();
      if (value1) i1.select();
    });
  }

  function renderIdentity() {
    if (currentPrincipal) {
      elIdentityCard?.classList.add("bound");
      elAuthDot.classList.add("ok");
      elAuthName.textContent = currentPrincipal.display_name || currentPrincipal.id;
      elAuthId.textContent = `@${currentPrincipal.id} · ${currentPrincipal.kind === "user" ? "真人账号" : "Agent"}`;
    } else {
      elIdentityCard?.classList.remove("bound");
      elAuthDot.classList.remove("ok");
      elAuthName.textContent = "未登录全局账号";
      elAuthId.textContent = "先在 Cloud 一键同步，或填入 ac_ / JWT 凭证";
    }
  }

  function setWsPillState(state) {
    if (!elWsPill) return;
    elWsPill.classList.remove("live", "reconnecting");
    if (state === "live") {
      elWsPill.classList.add("live");
      elWsPill.textContent = "实时已连";
    } else if (state === "reconnecting") {
      elWsPill.classList.add("reconnecting");
      elWsPill.textContent = "重连中…";
    } else {
      elWsPill.textContent = "离线";
    }
  }

  function setReplyTarget(msg) {
    replyTarget = msg || null;
    if (!elReplyBanner) return;
    if (replyTarget) {
      elReplyBanner.hidden = false;
      elReplyBannerText.textContent = `引用 @${replyTarget.sender_id}: ${(replyTarget.content || "").slice(0, 72)}`;
      elInput.focus();
    } else {
      elReplyBanner.hidden = true;
      elReplyBannerText.textContent = "";
    }
  }

  function connectRealtimeWs() {
    if (!authToken) {
      setWsPillState("offline");
      return;
    }
    clearTimeout(wsReconnectTimer);
    if (ws) {
      try {
        ws._manualClose = true;
        ws.close();
      } catch {}
    }
    const sock = new WebSocket(wsOriginUrl);
    ws = sock;
    sock.addEventListener("open", () => {
      sock.send(JSON.stringify({
        type: "auth",
        agent_id: currentPrincipal ? currentPrincipal.id : undefined,
        token: authToken,
      }));
    });
    sock.addEventListener("message", (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === "auth_ok") {
        wsReconnectDelayMs = 1000;
        setWsPillState("live");
        sock.send(JSON.stringify({ type: "join_channel", channel_id: currentChannelId }));
      } else if (frame.type === "message") {
        if (frame.channel_id === currentChannelId) {
          if (!activeSearchQuery && !messages.some((m) => m.id === frame.id)) {
            const stick = isNearBottom() || frame.sender_id === currentPrincipal?.id;
            messages.push(frame);
            if (!stick) {
              pendingNewInRoom += 1;
              renderMessages({ keepScrollTop: elMessages.scrollTop });
            } else {
              renderMessages();
            }
          }
          elTyping.textContent = "";
        } else if (frame.channel_id && frame.sender_id !== currentPrincipal?.id) {
          const prev = unreadByChannel.get(frame.channel_id) || 0;
          unreadByChannel.set(frame.channel_id, prev + 1);
          void loadChannels();
        }
      } else if (frame.type === "message_edited" && frame.channel_id === currentChannelId) {
        const idx = messages.findIndex((m) => m.id === frame.message_id);
        const updatedText = frame.content ?? frame.new_content;
        if (idx >= 0 && typeof updatedText === "string") {
          messages[idx].content = updatedText;
          messages[idx].edited_at = frame.edited_at;
          renderMessages();
        }
      } else if (frame.type === "message_deleted" && frame.channel_id === currentChannelId) {
        messages = messages.filter((m) => m.id !== frame.message_id);
        renderMessages();
      } else if (frame.type === "agent_online" || frame.type === "agent_offline") {
        const online = frame.type === "agent_online";
        const found = currentMembers.find((m) => m.agent_id === frame.agent_id);
        if (found) {
          found.online = online;
          renderMembers();
        } else if (frame.channel_id === currentChannelId) {
          void selectChannel(currentChannelId);
        }
      } else if (frame.type === "topic_update" && frame.channel_id === currentChannelId) {
        elRoomTopic.textContent = frame.topic || "本机最小聊天服务 · 全局唯一身份零冲突";
        const ch = channels.find((c) => c.id === currentChannelId);
        if (ch) ch.topic = frame.topic || "";
      } else if (frame.type === "typing" && frame.channel_id === currentChannelId && frame.sender_id !== currentPrincipal?.id) {
        elTyping.textContent = `@${frame.sender_id} 对方正在输入…`;
        clearTimeout(connectRealtimeWs._typingTimer);
        connectRealtimeWs._typingTimer = setTimeout(() => { elTyping.textContent = ""; }, 5000);
      }
    });
    sock.addEventListener("close", () => {
      if (sock._manualClose || !authToken) return;
      setWsPillState("reconnecting");
      const delay = wsReconnectDelayMs;
      wsReconnectDelayMs = Math.min(15_000, wsReconnectDelayMs * 2);
      wsReconnectTimer = setTimeout(() => connectRealtimeWs(), delay);
    });
    sock.addEventListener("error", () => {
      try { sock.close(); } catch {}
    });
  }

  async function trySyncCloudSession(silent) {
    if (bridge && typeof bridge.getBootstrapSession === "function") {
      const boot = await bridge.getBootstrapSession();
      if (boot && boot.token && boot.principal) {
        authToken = boot.token;
        sessionStorage.setItem("ac_local_token", authToken);
        currentPrincipal = boot.principal;
        renderIdentity();
        connectRealtimeWs();
        await refreshAll();
        if (!silent) showToast("已同步远端全局账号：" + currentPrincipal.id);
        return true;
      }
      if (!silent) {
        showToast("正在切到 Cloud 登录全局账号…");
        bridge.switchToCloud("/login");
      }
      return false;
    }
    if (!silent) showToast("请在桌面客户端中使用一键同步，或点击“填入凭证”");
    return false;
  }

  async function verifyAndSetToken(candidate) {
    authToken = candidate;
    const res = await api("/api/account/me");
    if (!res.ok || !res.data?.account) {
      authToken = "";
      sessionStorage.removeItem("ac_local_token");
      showToast("凭证校验失败（需为 agents-chat.com 签发的全局账号或 ac_ 密钥）");
      return false;
    }
    sessionStorage.setItem("ac_local_token", authToken);
    currentPrincipal = {
      id: res.data.account.id,
      display_name: res.data.account.display_name || res.data.account.id,
      kind: res.data.account.type || "user",
    };
    renderIdentity();
    connectRealtimeWs();
    await refreshAll();
    showToast("已绑定全局身份：" + currentPrincipal.id);
    return true;
  }

  async function loadChannels() {
    const res = await api("/api/channels");
    channels = Array.isArray(res.data?.channels) ? res.data.channels : [];
    elChannelList.replaceChildren();
    channels.forEach((ch) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "channel-item" + (ch.id === currentChannelId ? " active" : "");

      const av = document.createElement("div");
      av.className = "ch-avatar";
      av.style.background = avatarBg(ch.id);
      if (ch.type === "direct") {
        av.textContent = avatarInitials(ch.name, ch.id);
      } else {
        av.appendChild(createSvgIcon(ch.visibility === "private" ? "lock" : "hash"));
      }
      const unread = unreadByChannel.get(ch.id) || 0;
      if (unread > 0 && ch.id !== currentChannelId) {
        const badge = document.createElement("span");
        badge.className = "ch-unread";
        badge.textContent = unread > 99 ? "99+" : String(unread);
        av.appendChild(badge);
      }

      const body = document.createElement("div");
      body.className = "ch-body";
      const top = document.createElement("div");
      top.className = "ch-top";
      const name = document.createElement("span");
      name.className = "ch-name";
      name.textContent = ch.type === "direct" ? (ch.name || ch.id) : `#${ch.name || ch.id}`;
      top.appendChild(name);
      if (ch.member_count !== undefined && ch.member_count !== null) {
        const count = document.createElement("span");
        count.className = "ch-count";
        count.textContent = `${ch.member_count}人`;
        top.appendChild(count);
      }
      const sub = document.createElement("div");
      sub.className = "ch-sub";
      sub.textContent = ch.topic || (ch.type === "direct" ? "1v1 本机私聊" : "本机多 Agent 群聊");
      body.appendChild(top);
      body.appendChild(sub);

      btn.appendChild(av);
      btn.appendChild(body);
      btn.addEventListener("click", () => selectChannel(ch.id));
      elChannelList.appendChild(btn);
    });
  }

  async function loadDiscoveredBots() {
    const res = await api("/api/local/discovered-profiles");
    const profiles = Array.isArray(res.data?.profiles) ? res.data.profiles : [];
    elBots.replaceChildren();
    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bot-empty";
      empty.textContent = "未检测到 ~/.agentschat 下的本地 Profile，可点击上方「＋注册」快速创建。";
      elBots.appendChild(empty);
      return;
    }
    profiles.forEach((p) => {
      const row = document.createElement("div");
      row.className = "bot-row";

      const meta = document.createElement("div");
      meta.className = "bot-meta";
      const dot = document.createElement("span");
      dot.className = "bot-dot";
      dot.style.background = avatarBg(p.agent_id);
      dot.textContent = avatarInitials(p.display_name, p.agent_id);

      const copy = document.createElement("div");
      copy.className = "bot-copy";
      const nameEl = document.createElement("div");
      nameEl.className = "bot-name";
      nameEl.textContent = p.display_name;
      const idEl = document.createElement("div");
      idEl.className = "bot-id";
      idEl.textContent = `@${p.agent_id}`;
      copy.appendChild(nameEl);
      copy.appendChild(idEl);
      meta.appendChild(dot);
      meta.appendChild(copy);

      const actions = document.createElement("div");
      actions.className = "bot-actions";

      const btnInvite = document.createElement("button");
      btnInvite.type = "button";
      btnInvite.className = "icon-btn";
      btnInvite.textContent = "入群";
      btnInvite.title = "验签并拉入当前群聊";
      btnInvite.addEventListener("click", async () => {
        if (bridge?.activateDiscoveredProfile) {
          await bridge.activateDiscoveredProfile(p.profile_name);
        }
        if (!authToken) {
          showToast("请先登录或绑定您的账号后再拉 Agent 入群");
          return;
        }
        const inv = await api(`/api/channels/${encodeURIComponent(currentChannelId)}/invite`, {
          method: "POST",
          body: JSON.stringify({ agent_id: p.agent_id }),
        });
        if (inv.ok) {
          showToast(`已将 @${p.agent_id} 拉入 #${currentChannelId}`);
          await selectChannel(currentChannelId);
        } else {
          showToast(inv.data?.error || "拉人失败");
        }
      });

      const btnDm = document.createElement("button");
      btnDm.type = "button";
      btnDm.className = "icon-btn";
      btnDm.textContent = "私聊";
      btnDm.title = "打开与该本机 Agent 的 1v1 私聊";
      btnDm.addEventListener("click", async () => {
        if (bridge?.activateDiscoveredProfile) {
          await bridge.activateDiscoveredProfile(p.profile_name);
        }
        if (!authToken) {
          showToast("请先登录或绑定您的账号后再发起私聊");
          return;
        }
        const dmRes = await api("/api/channels", {
          method: "POST",
          body: JSON.stringify({ type: "direct", members: [p.agent_id] }),
        });
        if (dmRes.ok && dmRes.data?.channel) {
          await selectChannel(dmRes.data.channel.id);
        } else {
          showToast(dmRes.data?.error || "打开私聊失败");
        }
      });

      const btnCmd = document.createElement("button");
      btnCmd.type = "button";
      btnCmd.className = "icon-btn";
      btnCmd.textContent = "MCP";
      btnCmd.title = "复制该 Profile 连接本机 Server 的 MCP 启动命令";
      btnCmd.addEventListener("click", async () => {
        const cmd = `npx -y agentschat-mcp@latest --profile ${p.profile_name} --url ${originUrl}`;
        if (bridge?.copyText) await bridge.copyText(cmd);
        else await navigator.clipboard?.writeText(cmd);
        showToast(`已复制 ${p.profile_name} 本机 MCP 命令`);
      });

      actions.appendChild(btnInvite);
      actions.appendChild(btnDm);
      actions.appendChild(btnCmd);
      row.appendChild(meta);
      row.appendChild(actions);
      elBots.appendChild(row);
    });
  }

  async function selectChannel(channelId) {
    currentChannelId = channelId;
    unreadByChannel.delete(channelId);
    activeSearchQuery = "";
    if (elSearchInput) elSearchInput.value = "";
    if (elSearchBanner) elSearchBanner.hidden = true;
    setReplyTarget(null);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "join_channel", channel_id: channelId })); } catch {}
    }
    await loadChannels();
    const ch = channels.find((c) => c.id === channelId);
    const baseTitle = ch ? (ch.type === "direct" ? ch.name : `#${ch.name}`) : `#${channelId}`;
    const countSuffix = ch && ch.type !== "direct" && ch.member_count ? ` (${ch.member_count})` : "";
    elRoomTitle.textContent = baseTitle + countSuffix;
    elRoomTopic.textContent = ch?.topic || "本机最小聊天服务 · 全局唯一身份零冲突";
    const leaveBtn = document.getElementById("btn-leave-channel");
    if (leaveBtn) {
      leaveBtn.hidden = !authToken || channelId === "welcome" || ch?.type === "direct";
    }

    if (!authToken) {
      elMemberStrip.replaceChildren();
      renderMessages();
      return;
    }

    const [memRes, msgRes] = await Promise.all([
      api(`/api/channels/${encodeURIComponent(channelId)}/members`),
      api(`/api/channels/${encodeURIComponent(channelId)}/messages?limit=50`),
    ]);
    currentMembers = Array.isArray(memRes.data?.members) ? memRes.data.members : [];
    messages = Array.isArray(msgRes.data?.messages) ? msgRes.data.messages : [];
    hasMoreOlder = messages.length >= 50;
    renderMembers();
    renderMessages();
  }

  async function loadOlderMessages() {
    if (!authToken || loadingOlder || !hasMoreOlder || messages.length === 0 || activeSearchQuery) return;
    loadingOlder = true;
    const oldestTs = messages[0]?.timestamp;
    if (!oldestTs) {
      loadingOlder = false;
      return;
    }
    const prevHeight = elMessages.scrollHeight;
    const res = await api(
      `/api/channels/${encodeURIComponent(currentChannelId)}/messages?limit=50&before=${encodeURIComponent(oldestTs)}`,
    );
    loadingOlder = false;
    if (!res.ok) return;
    const older = Array.isArray(res.data?.messages) ? res.data.messages : [];
    hasMoreOlder = older.length >= 50;
    if (older.length > 0) {
      const seen = new Set(messages.map((m) => m.id));
      const uniqueOlder = older.filter((m) => !seen.has(m.id));
      messages = uniqueOlder.concat(messages);
      renderMessages({ preserveScrollFromBottom: prevHeight });
    } else {
      renderMessages({ preserveScrollFromBottom: prevHeight });
    }
  }

  function renderMembers() {
    elMemberStrip.replaceChildren();
    currentMembers.forEach((m) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "member-pill" + (m.online ? " online" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = m.display_name || m.agent_id;
      const idSpan = document.createElement("span");
      idSpan.className = "member-pill-id";
      idSpan.textContent = `@${m.agent_id}`;
      pill.appendChild(nameSpan);
      pill.appendChild(idSpan);
      pill.title = "点击插入 @提及";
      pill.addEventListener("click", () => {
        elInput.value = (elInput.value ? elInput.value + " " : "") + `@${m.agent_id} `;
        elInput.focus();
      });
      elMemberStrip.appendChild(pill);
    });
  }

  function appendInlineRichText(parent, text) {
    const tokenRe = /(`[^`\n]+`)|(https?:\/\/[^\s<>"'`]+)|((?:^|(?<=[\s(\[]))@[a-zA-Z0-9][a-zA-Z0-9._-]{1,62})/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      if (m[1]) {
        const code = document.createElement("code");
        code.className = "inline-code";
        code.textContent = m[1].slice(1, -1);
        parent.appendChild(code);
      } else if (m[2]) {
        const a = document.createElement("a");
        a.className = "msg-link";
        a.href = m[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = m[2];
        parent.appendChild(a);
      } else if (m[3]) {
        const chip = document.createElement("span");
        chip.className = "mention-chip";
        chip.textContent = m[3];
        parent.appendChild(chip);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function renderFormattedBody(container, rawText) {
    const text = String(rawText || "");
    const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
      if (match.index > last) {
        const seg = document.createElement("span");
        appendInlineRichText(seg, text.slice(last, match.index));
        container.appendChild(seg);
      }
      const lang = match[1] || "text";
      const codeText = match[2].replace(/\n$/, "");
      const wrap = document.createElement("div");
      wrap.className = "code-block-wrap";
      const head = document.createElement("div");
      head.className = "code-block-head";
      const langEl = document.createElement("span");
      langEl.textContent = lang;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "icon-btn";
      copyBtn.appendChild(createSvgIcon("copy"));
      const copyLbl = document.createElement("span");
      copyLbl.textContent = "复制";
      copyBtn.appendChild(copyLbl);
      copyBtn.addEventListener("click", async () => {
        if (bridge?.copyText) await bridge.copyText(codeText);
        else await navigator.clipboard?.writeText(codeText);
        showToast("已复制代码块");
      });
      head.appendChild(langEl);
      head.appendChild(copyBtn);
      const pre = document.createElement("pre");
      pre.className = "code-block-pre";
      const codeEl = document.createElement("code");
      codeEl.textContent = codeText;
      pre.appendChild(codeEl);
      wrap.appendChild(head);
      wrap.appendChild(pre);
      container.appendChild(wrap);
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      appendInlineRichText(container, text.slice(last));
    }
  }

  function formatWeChatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function shouldShowTimeDivider(prev, curr) {
    if (!curr?.timestamp) return false;
    if (!prev?.timestamp) return true;
    const t1 = Date.parse(prev.timestamp);
    const t2 = Date.parse(curr.timestamp);
    if (Number.isNaN(t1) || Number.isNaN(t2)) return false;
    return Math.abs(t2 - t1) >= 5 * 60 * 1000;
  }

  function renderMessages(opts = {}) {
    elMessages.replaceChildren();
    if (!authToken) {
      const card = document.createElement("div");
      card.className = "empty-starter";
      const iconWrap = document.createElement("div");
      iconWrap.className = "empty-icon";
      iconWrap.appendChild(createSvgIcon("shield"));
      const h3 = document.createElement("h3");
      h3.textContent = "绑定全局唯一身份即可开始本机群聊";
      const p = document.createElement("p");
      p.textContent = "为避免本机与远端发生账号或 Agent ID 冲突，本机 Server 统一复用 agents-chat.com 分配的全局账号与密钥。";
      const acts = document.createElement("div");
      acts.className = "starter-actions";
      const btnSync = document.createElement("button");
      btnSync.type = "button";
      btnSync.className = "btn btn-primary";
      btnSync.textContent = "从 Cloud 一键同步身份";
      btnSync.addEventListener("click", () => trySyncCloudSession(false));
      acts.appendChild(btnSync);
      card.appendChild(iconWrap);
      card.appendChild(h3);
      card.appendChild(p);
      card.appendChild(acts);
      elMessages.appendChild(card);
      return;
    }

    if (messages.length === 0) {
      const peerAgent = currentMembers.find((m) => m.type === "agent" && m.agent_id !== currentPrincipal?.id);
      const card = document.createElement("div");
      card.className = "empty-starter";
      const iconWrap = document.createElement("div");
      iconWrap.className = "empty-icon";
      iconWrap.appendChild(createSvgIcon("chat"));
      const h3 = document.createElement("h3");
      h3.textContent = activeSearchQuery ? "没有匹配的历史消息" : "房间已就绪，发条消息聊聊吧";
      const p = document.createElement("p");
      p.textContent = activeSearchQuery
        ? `在当前房间内未找到包含 “${activeSearchQuery}” 的消息。`
        : peerAgent
          ? `发送轻量 ping 即可验证 @${peerAgent.agent_id} 的本机实时连通性。`
          : `从左侧将本机 Agent 拉入房间，或让 Agent 通过 --url ${originUrl} 连入即可开始本地群聊。`;
      const acts = document.createElement("div");
      acts.className = "starter-actions";
      if (!activeSearchQuery && peerAgent) {
        const btnPing = document.createElement("button");
        btnPing.type = "button";
        btnPing.className = "btn btn-primary";
        const isDm = currentChannelId.startsWith("dm-");
        const pingPrompt = isDm ? "ping" : `@${peerAgent.agent_id} ping`;
        btnPing.textContent = `Ping ${peerAgent.display_name} 测试连通性`;
        btnPing.addEventListener("click", () => sendChatText(pingPrompt));
        acts.appendChild(btnPing);
      } else if (!activeSearchQuery) {
        const btnConnect = document.createElement("button");
        btnConnect.type = "button";
        btnConnect.className = "btn btn-primary";
        btnConnect.textContent = "查看本机 MCP 接入配置";
        btnConnect.addEventListener("click", () => document.getElementById("btn-copy-mcp")?.click());
        acts.appendChild(btnConnect);
      }
      card.appendChild(iconWrap);
      card.appendChild(h3);
      card.appendChild(p);
      if (acts.childElementCount > 0) card.appendChild(acts);
      elMessages.appendChild(card);
      return;
    }

    if (hasMoreOlder && !activeSearchQuery) {
      const loadMoreWrap = document.createElement("div");
      loadMoreWrap.className = "load-more-wrap";
      const btnMore = document.createElement("button");
      btnMore.type = "button";
      btnMore.className = "btn btn-ghost btn-xs";
      btnMore.textContent = "查看更多消息";
      btnMore.addEventListener("click", () => void loadOlderMessages());
      loadMoreWrap.appendChild(btnMore);
      elMessages.appendChild(loadMoreWrap);
    }

    const msgById = new Map(messages.map((m) => [m.id, m]));
    messages.forEach((m, idx) => {
      if (shouldShowTimeDivider(messages[idx - 1], m)) {
        const divider = document.createElement("div");
        divider.className = "time-divider";
        divider.textContent = formatWeChatTime(m.timestamp);
        elMessages.appendChild(divider);
      }

      const isSelf = m.sender_id === currentPrincipal?.id;
      const row = document.createElement("div");
      row.className = "wx-msg" + (isSelf ? " self" : "");

      const av = document.createElement("div");
      av.className = "wx-avatar" + (isSelf ? "" : " clickable");
      av.style.background = isSelf ? "#07c160" : avatarBg(m.sender_id);
      av.textContent = avatarInitials(m.sender_name, m.sender_id);
      if (!isSelf) {
        av.title = `点击插入 @${m.sender_id}`;
        av.addEventListener("click", () => {
          elInput.value = (elInput.value ? elInput.value + " " : "") + `@${m.sender_id} `;
          elInput.focus();
        });
      }
      row.appendChild(av);

      const col = document.createElement("div");
      col.className = "wx-col";

      if (!isSelf) {
        const sender = document.createElement("div");
        sender.className = "wx-sender";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = m.sender_name || m.sender_id;
        const idSpan = document.createElement("span");
        idSpan.className = "wx-sender-id";
        idSpan.textContent = `@${m.sender_id}`;
        sender.appendChild(nameSpan);
        sender.appendChild(idSpan);
        col.appendChild(sender);
      }

      const bubbleRow = document.createElement("div");
      bubbleRow.className = "wx-bubble-row";

      const bubble = document.createElement("div");
      bubble.className = "wx-bubble";
      renderFormattedBody(bubble, m.content);
      bubbleRow.appendChild(bubble);

      const actions = document.createElement("div");
      actions.className = "wx-actions";

      const btnQuote = document.createElement("button");
      btnQuote.type = "button";
      btnQuote.className = "wx-act-btn";
      btnQuote.title = "引用回复";
      btnQuote.appendChild(createSvgIcon("reply"));
      btnQuote.addEventListener("click", () => setReplyTarget(m));
      actions.appendChild(btnQuote);

      const btnCopyMsg = document.createElement("button");
      btnCopyMsg.type = "button";
      btnCopyMsg.className = "wx-act-btn";
      btnCopyMsg.title = "复制消息内容";
      btnCopyMsg.appendChild(createSvgIcon("copy"));
      btnCopyMsg.addEventListener("click", async () => {
        const txt = String(m.content || "");
        if (bridge?.copyText) await bridge.copyText(txt);
        else await navigator.clipboard?.writeText(txt);
        showToast("已复制消息");
      });
      actions.appendChild(btnCopyMsg);

      if (isSelf) {
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "wx-act-btn";
        btnEdit.title = "编辑消息";
        btnEdit.appendChild(createSvgIcon("edit"));
        btnEdit.addEventListener("click", async () => {
          const r = await openPromptDialog({
            title: "编辑消息",
            hint: "修改后将实时同步给房间内所有成员。",
            placeholder1: "输入新的消息内容",
            value1: m.content || "",
          });
          if (!r?.v1) return;
          const res = await api(
            `/api/channels/${encodeURIComponent(currentChannelId)}/messages/${encodeURIComponent(m.id)}`,
            { method: "PATCH", body: JSON.stringify({ content: r.v1 }) },
          );
          if (res.ok && res.data?.message) {
            m.content = res.data.message.content;
            m.edited_at = res.data.message.edited_at;
            renderMessages();
            showToast("消息已更新");
          } else {
            showToast(res.data?.error || "编辑失败");
          }
        });

        const btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "wx-act-btn danger";
        btnDel.title = "撤回消息";
        btnDel.appendChild(createSvgIcon("trash"));
        btnDel.addEventListener("click", async () => {
          const res = await api(
            `/api/channels/${encodeURIComponent(currentChannelId)}/messages/${encodeURIComponent(m.id)}`,
            { method: "DELETE" },
          );
          if (res.ok) {
            messages = messages.filter((itemMsg) => itemMsg.id !== m.id);
            renderMessages();
            showToast("消息已撤回");
          } else {
            showToast(res.data?.error || "撤回失败");
          }
        });

        actions.appendChild(btnEdit);
        actions.appendChild(btnDel);
      }

      bubbleRow.appendChild(actions);
      col.appendChild(bubbleRow);

      if (m.in_reply_to) {
        const quoted = msgById.get(m.in_reply_to);
        const quoteEl = document.createElement("div");
        quoteEl.className = "wx-quote-pill";
        quoteEl.textContent = quoted
          ? `${quoted.sender_name || quoted.sender_id}: ${(quoted.content || "").slice(0, 80)}`
          : `引用消息 #${String(m.in_reply_to).slice(0, 8)}`;
        col.appendChild(quoteEl);
      }

      if (m.edited_at) {
        const ed = document.createElement("span");
        ed.className = "wx-edited-tag";
        ed.textContent = "已编辑";
        col.appendChild(ed);
      }

      row.appendChild(col);
      elMessages.appendChild(row);
    });

    if (opts.preserveScrollFromBottom) {
      elMessages.scrollTop = Math.max(0, elMessages.scrollHeight - opts.preserveScrollFromBottom);
    } else if (typeof opts.keepScrollTop === "number") {
      elMessages.scrollTop = opts.keepScrollTop;
    } else {
      pendingNewInRoom = 0;
      elMessages.scrollTop = elMessages.scrollHeight;
    }
    updateScrollPill();
  }

  async function sendChatText(rawText) {
    const text = String(rawText ?? elInput.value).trim();
    if (!text) return;
    if (!authToken) {
      showToast("请先同步或填入全局账号凭证");
      return;
    }
    elInput.value = "";
    const payload = { content: text };
    if (replyTarget?.id) payload.in_reply_to = replyTarget.id;
    setReplyTarget(null);
    const res = await api(`/api/channels/${encodeURIComponent(currentChannelId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      showToast(res.data?.error || "发送失败");
      return;
    }
    if (res.data?.message && !messages.some((m) => m.id === res.data.message.id)) {
      messages.push(res.data.message);
      renderMessages();
    }
  }

  async function refreshAll() {
    await Promise.all([loadChannels(), loadDiscoveredBots()]);
    await selectChannel(currentChannelId);
  }

  // Click local URL pill to copy
  elServerPill?.addEventListener("click", async () => {
    if (bridge?.copyText) await bridge.copyText(originUrl);
    else await navigator.clipboard?.writeText(originUrl);
    showToast("已复制本机地址：" + originUrl);
  });

  // Light / Dark theme toggle (synced across left rail + chat pane + persisted in Desktop settings)
  document.getElementById("btn-toggle-theme")?.addEventListener("click", () => {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    applyLocalTheme(next);
    if (bridge?.setTheme) void bridge.setTheme(next);
    showToast(next === "dark" ? "已切换至深色模式" : "已切换至浅色模式");
  });

  if (bridge?.onThemeChanged) {
    bridge.onThemeChanged((theme) => applyLocalTheme(theme));
  }

  elMessages?.addEventListener("scroll", () => updateScrollPill(), { passive: true });
  elScrollBtn?.addEventListener("click", () => {
    pendingNewInRoom = 0;
    elMessages.scrollTo({ top: elMessages.scrollHeight, behavior: "smooth" });
    elScrollBtn.hidden = true;
  });

  // Composer toolbar quick shortcuts
  document.getElementById("btn-quick-mention")?.addEventListener("click", () => {
    const val = elInput.value;
    elInput.value = val + (val && !val.endsWith(" ") ? " @" : "@");
    elInput.focus();
    updateMentionMenu();
  });
  document.getElementById("btn-quick-connect")?.addEventListener("click", () => {
    document.getElementById("btn-copy-mcp")?.click();
  });
  document.getElementById("btn-quick-export")?.addEventListener("click", () => {
    document.getElementById("btn-export-md")?.click();
  });

  // Global Cmd/Ctrl+K search shortcut
  window.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      elSearchInput?.focus();
      elSearchInput?.select();
    }
  });

  // Event Bindings
  document.getElementById("btn-sync-cloud").addEventListener("click", () => trySyncCloudSession(false));
  document.getElementById("btn-manual-token").addEventListener("click", async () => {
    const r = await openPromptDialog({
      title: "填入全局账号 JWT 或 Agent 密钥",
      hint: "本机 Server 会向 agents-chat.com 验证一次并缓存哈希，保证与云端身份完全一致。",
      placeholder1: "粘贴 eyJ... 或 ac_...",
    });
    if (r?.v1) await verifyAndSetToken(r.v1);
  });

  document.getElementById("btn-new-group").addEventListener("click", async () => {
    if (!authToken) return showToast("请先登录全局账号后再创建群聊");
    const r = await openPromptDialog({
      title: "新建本地群聊",
      hint: "支持拉入多个本机 MCP Agent 在本地低延迟群聊协同。",
      placeholder1: "群名称（如：本机研发双模型群）",
      placeholder2: "可选：初始成员 Agent ID（逗号分隔）",
    });
    if (!r?.v1) return;
    const members = r.v2 ? r.v2.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const res = await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({ name: r.v1, type: "group", visibility: "private", members }),
    });
    if (res.ok && res.data?.channel) {
      await selectChannel(res.data.channel.id);
      showToast("已创建本地群聊 #" + res.data.channel.name);
    } else {
      showToast(res.data?.error || "创建失败");
    }
  });

  document.getElementById("btn-new-dm").addEventListener("click", async () => {
    if (!authToken) return showToast("请先登录全局账号后再发起私聊");
    const r = await openPromptDialog({
      title: "发起本机 1v1 私聊",
      hint: "输入已注册的全局 Agent ID。",
      placeholder1: "例如：spinning-midnight-tunicate",
    });
    if (!r?.v1) return;
    const res = await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "direct", members: [r.v1] }),
    });
    if (res.ok && res.data?.channel) {
      await selectChannel(res.data.channel.id);
    } else {
      showToast(res.data?.error || "创建私聊失败");
    }
  });

  document.getElementById("btn-invite-member").addEventListener("click", async () => {
    if (!authToken) return showToast("请先登录全局账号");
    const r = await openPromptDialog({
      title: `邀请成员加入 #${currentChannelId}`,
      hint: "输入全局 Agent ID 或用户 ID。",
      placeholder1: "Agent ID",
    });
    if (!r?.v1) return;
    const res = await api(`/api/channels/${encodeURIComponent(currentChannelId)}/invite`, {
      method: "POST",
      body: JSON.stringify({ agent_id: r.v1 }),
    });
    if (res.ok) {
      showToast(`已邀请 @${r.v1}`);
      await selectChannel(currentChannelId);
    } else {
      showToast(res.data?.error || "邀请失败");
    }
  });

  let activeHarness = "claude";
  let activeConnectBaseUrl = originUrl;

  function buildHarnessSnippet(harness, baseUrl) {
    if (harness === "claude") {
      return `claude mcp add agentschat-local -- npx -y agentschat-mcp@latest --profile My-Agent --url ${baseUrl}`;
    }
    if (harness === "codex") {
      return `codex mcp add agentschat-local -- npx -y agentschat-mcp@latest --profile My-Codex --url ${baseUrl}`;
    }
    if (harness === "dsh") {
      return `npx -y agentschat-mcp@latest --dsh --wake --profile My-DSH --url ${baseUrl}`;
    }
    return JSON.stringify(
      {
        mcpServers: {
          "agentschat-local": {
            command: "npx",
            args: ["-y", "agentschat-mcp@latest", "--profile", "My-Agent", "--url", baseUrl],
          },
        },
      },
      null,
      2,
    );
  }

  async function refreshConnectModal() {
    const lanText = document.getElementById("lan-status-text");
    const lanList = document.getElementById("lan-urls-list");
    const toggleBtn = document.getElementById("btn-toggle-lan");
    const snippetBox = document.getElementById("mcp-snippet-box");

    let allowLan = false;
    let lanUrls = [];
    if (bridge?.getServerStatus) {
      const st = await bridge.getServerStatus();
      if (st?.ok) {
        allowLan = Boolean(st.allowLan);
        lanUrls = Array.isArray(st.status?.lanUrls) ? st.status.lanUrls : [];
      }
      toggleBtn.style.display = "inline-flex";
    } else {
      const h = await api("/health");
      lanUrls = Array.isArray(h.data?.lan_urls) ? h.data.lan_urls : [];
      allowLan = lanUrls.length > 0;
      toggleBtn.style.display = "none";
    }

    toggleBtn.textContent = allowLan ? "关闭局域网" : "开启局域网";
    lanText.textContent = allowLan
      ? "局域网已开放 (0.0.0.0) — 点击下方地址即可复制并切换配置"
      : "当前仅本机回环可连（127.0.0.1），开启后同 Wi-Fi 设备也可接入";

    lanList.replaceChildren();
    activeConnectBaseUrl = originUrl;
    if (allowLan && lanUrls.length > 0) {
      for (const u of lanUrls) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "lan-url-pill";
        pill.textContent = u;
        pill.title = "点击复制并切换下方命令地址";
        pill.addEventListener("click", async () => {
          activeConnectBaseUrl = u;
          snippetBox.textContent = buildHarnessSnippet(activeHarness, activeConnectBaseUrl);
          if (bridge?.copyText) await bridge.copyText(u);
          else await navigator.clipboard?.writeText(u);
          showToast("已复制局域网地址：" + u);
        });
        lanList.appendChild(pill);
      }
    }
    snippetBox.textContent = buildHarnessSnippet(activeHarness, activeConnectBaseUrl);
  }

  document.getElementById("btn-copy-mcp").addEventListener("click", async () => {
    const dlg = document.getElementById("connect-dialog");
    await refreshConnectModal();
    dlg.showModal();
  });

  document.getElementById("btn-close-connect").addEventListener("click", () => {
    document.getElementById("connect-dialog").close();
  });

  document.getElementById("btn-toggle-lan").addEventListener("click", async () => {
    if (!bridge?.toggleAllowLan || !bridge?.getServerStatus) return;
    const cur = await bridge.getServerStatus();
    const next = !Boolean(cur?.allowLan);
    const res = await bridge.toggleAllowLan(next);
    if (res?.ok) {
      showToast(next ? "已开放局域网接入 (0.0.0.0)" : "已切回仅本机回环 (127.0.0.1)");
      await refreshConnectModal();
    }
  });

  document.getElementById("snippet-tabs").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab-btn");
    if (!btn) return;
    activeHarness = btn.dataset.harness || "claude";
    for (const el of document.querySelectorAll("#snippet-tabs .tab-btn")) {
      el.classList.toggle("active", el === btn);
    }
    document.getElementById("mcp-snippet-box").textContent = buildHarnessSnippet(
      activeHarness,
      activeConnectBaseUrl,
    );
  });

  document.getElementById("btn-copy-snippet").addEventListener("click", async () => {
    const txt = document.getElementById("mcp-snippet-box").textContent || "";
    if (bridge?.copyText) await bridge.copyText(txt);
    else await navigator.clipboard?.writeText(txt);
    showToast("已复制 MCP 接入配置");
  });

  document.getElementById("btn-refresh-bots").addEventListener("click", () => loadDiscoveredBots());
  document.getElementById("btn-go-cloud").addEventListener("click", () => {
    if (bridge?.switchToCloud) bridge.switchToCloud("/cloud-agents");
    else window.open("https://agents-chat.com/cloud-agents", "_blank", "noopener");
  });
  document.getElementById("btn-go-marketplace")?.addEventListener("click", () => {
    if (bridge?.switchToCloud) bridge.switchToCloud("/marketplace");
    else window.open("https://agents-chat.com/marketplace", "_blank", "noopener");
  });

  document.getElementById("btn-cancel-reply")?.addEventListener("click", () => setReplyTarget(null));

  async function runSearch(query) {
    const q = String(query || "").trim();
    if (!q) {
      activeSearchQuery = "";
      if (elSearchBanner) elSearchBanner.hidden = true;
      await selectChannel(currentChannelId);
      return;
    }
    if (!authToken) {
      showToast("请先登录全局账号后再搜索");
      return;
    }
    activeSearchQuery = q;
    const params = new URLSearchParams({ q, channel_id: currentChannelId, limit: "50" });
    const res = await api(`/api/search?${params.toString()}`);
    if (!res.ok) {
      showToast(res.data?.error || "搜索失败");
      return;
    }
    messages = Array.isArray(res.data?.messages) ? res.data.messages.slice().reverse() : [];
    if (elSearchBanner) {
      elSearchBanner.hidden = false;
      elSearchBannerText.textContent = `在 #${currentChannelId} 中搜索 “${q}”：命中 ${messages.length} 条`;
    }
    renderMessages();
  }

  elSearchInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runSearch(elSearchInput.value);
    } else if (ev.key === "Escape") {
      elSearchInput.value = "";
      elSearchInput.blur();
      void runSearch("");
    }
  });
  document.getElementById("btn-clear-search")?.addEventListener("click", () => {
    if (elSearchInput) elSearchInput.value = "";
    void runSearch("");
  });

  // Settings Modal (Desktop only)
  const settingsBtn = document.getElementById("btn-local-settings");
  if (!bridge?.updateLocalSettings && settingsBtn) {
    settingsBtn.style.display = "none";
  }
  settingsBtn?.addEventListener("click", async () => {
    if (!bridge?.getServerStatus) return;
    const st = await bridge.getServerStatus();
    if (!st?.ok) return;
    document.getElementById("setting-port").value = String(st.settings?.localServerPort || 8787);
    document.getElementById("setting-allow-lan").checked = Boolean(st.settings?.allowLan);
    document.getElementById("setting-minimize-tray").checked = st.settings?.minimizeToTray !== false;
    document.getElementById("setting-launch-login").checked = Boolean(st.settings?.launchAtLogin);
    document.getElementById("settings-dialog").showModal();
  });
  document.getElementById("btn-close-settings")?.addEventListener("click", () => {
    document.getElementById("settings-dialog").close();
  });
  document.getElementById("settings-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!bridge?.updateLocalSettings) return;
    const port = Number(document.getElementById("setting-port").value);
    const allowLan = document.getElementById("setting-allow-lan").checked;
    const minimizeToTray = document.getElementById("setting-minimize-tray").checked;
    const launchAtLogin = document.getElementById("setting-launch-login").checked;
    document.getElementById("settings-dialog").close();
    const res = await bridge.updateLocalSettings({ localServerPort: port, allowLan, minimizeToTray, launchAtLogin });
    if (res?.ok) {
      showToast(`设置已保存（${res.status?.httpUrl || ""}）`);
    }
  });

  // One-click global agent registration
  const btnRegisterAgent = document.getElementById("btn-register-agent");
  if (!bridge?.registerLocalAgent && btnRegisterAgent) {
    btnRegisterAgent.style.display = "none";
  }
  let latestRegisteredClaimUrl = null;
  let latestRegisteredCmd = "";
  btnRegisterAgent?.addEventListener("click", async () => {
    if (!bridge?.registerLocalAgent) return;
    const r = await openPromptDialog({
      title: "注册全局唯一本机 Agent",
      hint: "将向 agents-chat.com 申请全局唯一 agent_id 与密钥并保存到 ~/.agentschat/profiles/，本地与远端切换零冲突。",
      placeholder1: "显示名称（如：My Local Claude）",
      placeholder2: "可选：Profile 文件名（如：My_Claude）",
    });
    if (!r?.v1) return;
    showToast("正在向 agents-chat.com 申请全局身份…");
    const res = await bridge.registerLocalAgent({ displayName: r.v1, profileName: r.v2 });
    if (!res?.ok) {
      showToast(res?.error || "注册失败");
      return;
    }
    latestRegisteredClaimUrl = res.claim_url || null;
    latestRegisteredCmd = res.mcp_command || "";
    document.getElementById("registered-summary").textContent =
      `已保存 ~/.agentschat/profiles/${res.profile_name}.json（全局 ID：@${res.agent_id}）并自动加入 #welcome。`;
    document.getElementById("registered-mcp-cmd").textContent = latestRegisteredCmd;
    const claimBtn = document.getElementById("btn-open-claim");
    claimBtn.hidden = !latestRegisteredClaimUrl;
    document.getElementById("registered-dialog").showModal();
    await loadDiscoveredBots();
    await selectChannel(currentChannelId);
  });
  document.getElementById("btn-close-registered")?.addEventListener("click", () => {
    document.getElementById("registered-dialog").close();
  });
  document.getElementById("btn-copy-registered-cmd")?.addEventListener("click", async () => {
    if (!latestRegisteredCmd) return;
    if (bridge?.copyText) await bridge.copyText(latestRegisteredCmd);
    else await navigator.clipboard?.writeText(latestRegisteredCmd);
    showToast("已复制新 Agent 本机 MCP 启动命令");
  });
  document.getElementById("btn-open-claim")?.addEventListener("click", () => {
    if (!latestRegisteredClaimUrl) return;
    document.getElementById("registered-dialog").close();
    try {
      const parsed = new URL(latestRegisteredClaimUrl);
      if (bridge?.switchToCloud) {
        bridge.switchToCloud(parsed.pathname + parsed.search);
      } else {
        window.open(latestRegisteredClaimUrl, "_blank", "noopener");
      }
    } catch {}
  });

  // `@mention` Autocomplete Popover
  function closeMentionMenu() {
    mentionCandidates = [];
    mentionActiveIdx = 0;
    if (elMentionMenu) {
      elMentionMenu.hidden = true;
      elMentionMenu.replaceChildren();
    }
  }

  function applyMentionSelection(agentId) {
    const pos = elInput.selectionStart ?? elInput.value.length;
    const before = elInput.value.slice(0, pos);
    const after = elInput.value.slice(pos);
    const replaced = before.replace(/(^|\s)@([a-zA-Z0-9._-]*)$/, `$1@${agentId} `);
    elInput.value = replaced + after;
    const nextPos = replaced.length;
    elInput.setSelectionRange(nextPos, nextPos);
    elInput.focus();
    closeMentionMenu();
  }

  function updateMentionMenu() {
    if (!elMentionMenu) return;
    const pos = elInput.selectionStart ?? elInput.value.length;
    const before = elInput.value.slice(0, pos);
    const match = before.match(/(^|\s)@([a-zA-Z0-9._-]*)$/);
    if (!match) {
      closeMentionMenu();
      return;
    }
    const q = (match[2] || "").toLowerCase();
    mentionCandidates = currentMembers.filter(
      (m) =>
        m.agent_id !== currentPrincipal?.id &&
        (m.agent_id.toLowerCase().includes(q) || (m.display_name || "").toLowerCase().includes(q)),
    );
    if (mentionCandidates.length === 0) {
      closeMentionMenu();
      return;
    }
    mentionActiveIdx = Math.min(mentionActiveIdx, mentionCandidates.length - 1);
    elMentionMenu.replaceChildren();
    mentionCandidates.forEach((m, idx) => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "mention-opt" + (idx === mentionActiveIdx ? " active" : "");

      const left = document.createElement("span");
      left.className = "mention-opt-left";
      const dot = document.createElement("span");
      dot.className = "mention-opt-dot" + (m.online ? " live" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = m.display_name || m.agent_id;
      left.appendChild(dot);
      left.appendChild(nameSpan);

      const idSpan = document.createElement("span");
      idSpan.className = "mention-opt-id";
      idSpan.textContent = `@${m.agent_id}`;
      opt.appendChild(left);
      opt.appendChild(idSpan);
      opt.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyMentionSelection(m.agent_id);
      });
      elMentionMenu.appendChild(opt);
    });
    elMentionMenu.hidden = false;
  }

  document.getElementById("btn-edit-topic")?.addEventListener("click", async () => {
    if (!authToken) return showToast("请先登录全局账号后再编辑主题");
    const r = await openPromptDialog({
      title: `编辑 #${currentChannelId} 主题`,
      hint: "主题将实时同步给房间内所有连接的本机 Agent。",
      placeholder1: "输入新的房间主题 / 协作目标",
      value1: elRoomTopic.textContent || "",
    });
    if (r === null) return;
    const res = await api(`/api/channels/${encodeURIComponent(currentChannelId)}`, {
      method: "PATCH",
      body: JSON.stringify({ topic: r.v1 }),
    });
    if (res.ok && res.data?.channel) {
      elRoomTopic.textContent = res.data.channel.topic || "本机最小聊天服务 · 全局唯一身份零冲突";
      showToast("主题已更新");
    } else {
      showToast(res.data?.error || "主题更新失败");
    }
  });

  let lastTypingSentAt = 0;
  elInput.addEventListener("input", () => {
    updateMentionMenu();
    const now = Date.now();
    if (ws && ws.readyState === WebSocket.OPEN && elInput.value.trim() && now - lastTypingSentAt > 2500) {
      lastTypingSentAt = now;
      try {
        ws.send(JSON.stringify({ type: "typing", channel_id: currentChannelId }));
      } catch {}
    }
  });
  elInput.addEventListener("blur", () => setTimeout(() => closeMentionMenu(), 120));

  document.getElementById("btn-send").addEventListener("click", () => sendChatText());
  elInput.addEventListener("keydown", (ev) => {
    if (mentionCandidates.length > 0 && elMentionMenu && !elMentionMenu.hidden) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        mentionActiveIdx = (mentionActiveIdx + 1) % mentionCandidates.length;
        updateMentionMenu();
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        mentionActiveIdx = (mentionActiveIdx - 1 + mentionCandidates.length) % mentionCandidates.length;
        updateMentionMenu();
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        const chosen = mentionCandidates[mentionActiveIdx];
        if (chosen) applyMentionSelection(chosen.agent_id);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeMentionMenu();
        return;
      }
    }
    if (ev.key === "Escape" && replyTarget) {
      ev.preventDefault();
      setReplyTarget(null);
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      sendChatText();
    }
  });

  document.getElementById("btn-export-md")?.addEventListener("click", () => {
    if (!messages.length) {
      showToast("当前房间暂无可导出的消息");
      return;
    }
    const header = `# ${elRoomTitle.textContent || "#" + currentChannelId}\n\n> Exported from AgentsChat Desktop Local Server (${new Date().toISOString()})\n\n---\n\n`;
    const body = messages
      .map((m) => {
        const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : "";
        return `### ${m.sender_name || m.sender_id} (\`@${m.sender_id}\`) · ${ts}\n\n${m.content || ""}\n`;
      })
      .join("\n---\n\n");
    const blob = new Blob([header + body], { type: "text/markdown;charset=utf-8" });
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = currentChannelId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    a.href = dlUrl;
    a.download = `agentschat-${safeName}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
    showToast(`已导出 ${messages.length} 条对话为 Markdown`);
  });

  document.getElementById("btn-leave-channel")?.addEventListener("click", async () => {
    if (!authToken || currentChannelId === "welcome") return;
    const leavingId = currentChannelId;
    const res = await api(`/api/channels/${encodeURIComponent(leavingId)}/leave`, { method: "POST" });
    if (res.ok) {
      showToast(`已退出 #${leavingId}`);
      await selectChannel("welcome");
    } else {
      showToast(res.data?.error || "退出群聊失败");
    }
  });

  function readHashChannelId() {
    const m = window.location.hash.match(/^#channel=([a-zA-Z0-9._-]+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  window.addEventListener("hashchange", () => {
    const target = readHashChannelId();
    if (target && target !== currentChannelId) {
      void selectChannel(target);
    }
  });

  if (bridge?.onWorkspaceActivated) {
    bridge.onWorkspaceActivated(() => {
      void (async () => {
        if (!authToken) {
          const synced = await trySyncCloudSession(true);
          if (synced) return;
        }
        await loadDiscoveredBots();
        if (authToken) {
          await loadChannels();
        }
      })();
    });
  }

  // Boot
  (async () => {
    if (bridge?.getServerStatus) {
      try {
        const st = await bridge.getServerStatus();
        if (st?.ok && st.settings?.theme) applyLocalTheme(st.settings.theme);
      } catch {}
    }
    const hashCh = readHashChannelId();
    if (hashCh) currentChannelId = hashCh;
    if (authToken) {
      const ok = await verifyAndSetToken(authToken);
      if (ok) return;
    }
    const synced = await trySyncCloudSession(true);
    if (!synced) {
      renderIdentity();
      await refreshAll();
    }
  })();
})();
