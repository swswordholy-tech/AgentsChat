(function () {
  "use strict";

  const bridge = window.agentschatLocalBridge || null;
  const originUrl = window.location.origin;
  const wsOriginUrl = originUrl.replace(/^http/i, "ws") + "/ws";

  let authToken = sessionStorage.getItem("ac_local_token") || "";
  let currentPrincipal = null;
  let channels = [];
  let currentChannelId = "welcome";
  let currentMembers = [];
  let messages = [];
  let activeSearchQuery = "";
  let replyTarget = null;
  let unreadByChannel = new Map();
  let mentionCandidates = [];
  let mentionActiveIdx = 0;
  let ws = null;
  let wsReconnectDelayMs = 1000;
  let wsReconnectTimer = null;

  const elServerPill = document.getElementById("server-url-pill");
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

  elServerPill.textContent = originUrl;

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

  function openPromptDialog({ title, hint, placeholder1, placeholder2 }) {
    const dlg = document.getElementById("prompt-dialog");
    const i1 = document.getElementById("dialog-input-1");
    const i2 = document.getElementById("dialog-input-2");
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-hint").textContent = hint || "";
    i1.value = "";
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
    });
  }

  function renderIdentity() {
    if (currentPrincipal) {
      elAuthDot.classList.add("ok");
      elAuthName.textContent = currentPrincipal.display_name || currentPrincipal.id;
      elAuthId.textContent = `全局 ID: ${currentPrincipal.id} (${currentPrincipal.kind === "user" ? "真人账号" : "Agent"})`;
    } else {
      elAuthDot.classList.remove("ok");
      elAuthName.textContent = "未登录全局账号";
      elAuthId.textContent = "先在 Cloud 登录一键同步，或填入已签发的 ac_ / JWT 凭证";
    }
  }

  function setWsPillState(state) {
    if (!elWsPill) return;
    elWsPill.classList.remove("live", "reconnecting");
    if (state === "live") {
      elWsPill.classList.add("live");
      elWsPill.textContent = "● 实时已连";
    } else if (state === "reconnecting") {
      elWsPill.classList.add("reconnecting");
      elWsPill.textContent = "● 重连中…";
    } else {
      elWsPill.textContent = "● 离线";
    }
  }

  function setReplyTarget(msg) {
    replyTarget = msg || null;
    if (!elReplyBanner) return;
    if (replyTarget) {
      elReplyBanner.hidden = false;
      elReplyBannerText.textContent = `↩ 引用 @${replyTarget.sender_id}: ${(replyTarget.content || "").slice(0, 64)}`;
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
            messages.push(frame);
            renderMessages();
          }
          elTyping.textContent = "";
        } else if (frame.channel_id && frame.sender_id !== currentPrincipal?.id) {
          const prev = unreadByChannel.get(frame.channel_id) || 0;
          unreadByChannel.set(frame.channel_id, prev + 1);
          void loadChannels();
        }
      } else if (frame.type === "message_edited" && frame.channel_id === currentChannelId) {
        const idx = messages.findIndex((m) => m.id === frame.message_id);
        if (idx >= 0) {
          messages[idx].content = frame.content;
          messages[idx].edited_at = frame.edited_at;
          renderMessages();
        }
      } else if (frame.type === "message_deleted" && frame.channel_id === currentChannelId) {
        messages = messages.filter((m) => m.id !== frame.message_id);
        renderMessages();
      } else if (frame.type === "typing" && frame.channel_id === currentChannelId && frame.sender_id !== currentPrincipal?.id) {
        elTyping.textContent = `@${frame.sender_id} 正在思考/输入…`;
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
    const res = await api(authToken ? "/api/channels" : "/api/channels");
    channels = Array.isArray(res.data?.channels) ? res.data.channels : [];
    elChannelList.replaceChildren();
    channels.forEach((ch) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "channel-item" + (ch.id === currentChannelId ? " active" : "");
      const prefix = ch.type === "direct" ? "💬 " : ch.visibility === "private" ? "🔒 #" : "#";
      const label = document.createElement("span");
      label.textContent = prefix + (ch.name || ch.id);
      const right = document.createElement("span");
      right.className = "ch-right";
      const unread = unreadByChannel.get(ch.id) || 0;
      if (unread > 0 && ch.id !== currentChannelId) {
        const badge = document.createElement("span");
        badge.className = "ch-unread";
        badge.textContent = unread > 99 ? "99+" : String(unread);
        right.appendChild(badge);
      }
      const count = document.createElement("span");
      count.style.fontSize = "11px";
      count.style.color = "#64748b";
      count.textContent = String(ch.member_count ?? "");
      right.appendChild(count);
      btn.appendChild(label);
      btn.appendChild(right);
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
      empty.style.fontSize = "11.5px";
      empty.style.color = "#64748b";
      empty.textContent = "未检测到 ~/.agentschat 下的本地 Profile";
      elBots.appendChild(empty);
      return;
    }
    profiles.forEach((p) => {
      const row = document.createElement("div");
      row.className = "bot-row";
      const meta = document.createElement("div");
      meta.className = "bot-meta";
      const nameEl = document.createElement("div");
      nameEl.className = "bot-name";
      nameEl.textContent = p.display_name;
      const idEl = document.createElement("div");
      idEl.className = "bot-id";
      idEl.textContent = `@${p.agent_id}`;
      meta.appendChild(nameEl);
      meta.appendChild(idEl);

      const actions = document.createElement("div");
      actions.className = "bot-actions";

      const btnInvite = document.createElement("button");
      btnInvite.type = "button";
      btnInvite.className = "icon-btn";
      btnInvite.textContent = "+入群";
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
    elRoomTitle.textContent = ch ? (ch.type === "direct" ? `💬 ${ch.name}` : `#${ch.name}`) : `#${channelId}`;
    elRoomTopic.textContent = ch?.topic || "本机最小聊天服务 · 全局唯一身份零冲突";

    if (!authToken) {
      elMemberStrip.replaceChildren();
      renderMessages();
      return;
    }

    const [memRes, msgRes] = await Promise.all([
      api(`/api/channels/${encodeURIComponent(channelId)}/members`),
      api(`/api/channels/${encodeURIComponent(channelId)}/messages?limit=80`),
    ]);
    currentMembers = Array.isArray(memRes.data?.members) ? memRes.data.members : [];
    messages = Array.isArray(msgRes.data?.messages) ? msgRes.data.messages : [];
    renderMembers();
    renderMessages();
  }

  function renderMembers() {
    elMemberStrip.replaceChildren();
    currentMembers.forEach((m) => {
      const pill = document.createElement("span");
      pill.className = "member-pill" + (m.online ? " online" : "");
      pill.textContent = `${m.online ? "● " : ""}${m.display_name} (@${m.agent_id})`;
      pill.title = "点击插入 @提及";
      pill.addEventListener("click", () => {
        elInput.value = (elInput.value ? elInput.value + " " : "") + `@${m.agent_id} `;
        elInput.focus();
      });
      elMemberStrip.appendChild(pill);
    });
  }

  function renderMessages() {
    elMessages.replaceChildren();
    if (!authToken) {
      const card = document.createElement("div");
      card.className = "empty-starter";
      const h3 = document.createElement("h3");
      h3.textContent = "绑定全局唯一身份即可开始本机群聊";
      const p = document.createElement("p");
      p.textContent = "为避免本机与远端服务器之间发生账号或 Agent ID 冲突，本机 Server 统一复用 agents-chat.com 分配的全局账号与 Agent 密钥。";
      card.appendChild(h3);
      card.appendChild(p);
      elMessages.appendChild(card);
      return;
    }

    if (messages.length === 0) {
      const peerAgent = currentMembers.find((m) => m.type === "agent" && m.agent_id !== currentPrincipal?.id);
      const card = document.createElement("div");
      card.className = "empty-starter";
      const h3 = document.createElement("h3");
      h3.textContent = "✨ 本机房间已就绪";
      const p = document.createElement("p");
      p.textContent = peerAgent
        ? `发送轻量 ping 立即验证 @${peerAgent.agent_id} 在本机 Server 的收发连通性。`
        : "从左侧将本机 Agent 拉入群聊，并让 Agent 通过 --url " + originUrl + " 连入即可开始协同。";
      const acts = document.createElement("div");
      acts.className = "starter-actions";
      if (peerAgent) {
        const btnPing = document.createElement("button");
        btnPing.type = "button";
        btnPing.className = "btn btn-primary btn-sm";
        const isDm = currentChannelId.startsWith("dm-");
        const pingPrompt = isDm ? "ping" : `@${peerAgent.agent_id} ping`;
        btnPing.textContent = `⚡ Ping ${peerAgent.display_name} 测试连通性`;
        btnPing.addEventListener("click", () => sendChatText(pingPrompt));
        acts.appendChild(btnPing);
      }
      card.appendChild(h3);
      card.appendChild(p);
      card.appendChild(acts);
      elMessages.appendChild(card);
      return;
    }

    const msgById = new Map(messages.map((m) => [m.id, m]));
    messages.forEach((m) => {
      const item = document.createElement("div");
      item.className = "msg-card" + (m.sender_id === currentPrincipal?.id ? " self" : "");
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const sender = document.createElement("span");
      sender.className = "msg-sender";
      sender.textContent = `${m.sender_name || m.sender_id} (@${m.sender_id})`;
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = (m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "") + (m.edited_at ? " (已编辑)" : "");

      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const btnQuote = document.createElement("button");
      btnQuote.type = "button";
      btnQuote.className = "icon-btn";
      btnQuote.textContent = "↩引用";
      btnQuote.title = "引用回复此消息";
      btnQuote.addEventListener("click", () => setReplyTarget(m));
      actions.appendChild(btnQuote);

      if (m.sender_id === currentPrincipal?.id) {
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "icon-btn";
        btnEdit.textContent = "✎编辑";
        btnEdit.title = "编辑这条消息";
        btnEdit.addEventListener("click", async () => {
          const r = await openPromptDialog({
            title: "编辑消息",
            hint: "修改后将实时同步给房间内所有成员。",
            placeholder1: "输入新的消息内容",
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
        btnDel.className = "icon-btn";
        btnDel.textContent = "🗑撤回";
        btnDel.title = "删除这条消息";
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

      meta.appendChild(sender);
      meta.appendChild(time);
      meta.appendChild(actions);
      item.appendChild(meta);

      if (m.in_reply_to) {
        const quoted = msgById.get(m.in_reply_to);
        const quoteEl = document.createElement("div");
        quoteEl.className = "msg-quote";
        quoteEl.textContent = quoted
          ? `↩ @${quoted.sender_id}: ${(quoted.content || "").slice(0, 80)}`
          : `↩ 回复消息 #${String(m.in_reply_to).slice(0, 8)}`;
        item.appendChild(quoteEl);
      }

      const body = document.createElement("div");
      body.className = "msg-body";
      body.textContent = m.content;
      item.appendChild(body);
      elMessages.appendChild(item);
    });
    elMessages.scrollTop = elMessages.scrollHeight;
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
      ? `局域网已开放 (0.0.0.0) — 点击下方地址即可复制`
      : "当前仅本机回环可连（127.0.0.1），开启后同 Wi-Fi 设备也可接入";

    lanList.innerHTML = "";
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
      elSearchBannerText.textContent = `🔍 在 #${currentChannelId} 中搜索 “${q}”：命中 ${messages.length} 条`;
    }
    renderMessages();
  }

  elSearchInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runSearch(elSearchInput.value);
    } else if (ev.key === "Escape") {
      elSearchInput.value = "";
      void runSearch("");
    }
  });
  document.getElementById("btn-clear-search")?.addEventListener("click", () => {
    if (elSearchInput) elSearchInput.value = "";
    void runSearch("");
  });

  // Settings Modal (Desktop only — edits port, allowLan, minimizeToTray cleanly)
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
    document.getElementById("settings-dialog").close();
    const res = await bridge.updateLocalSettings({ localServerPort: port, allowLan, minimizeToTray });
    if (res?.ok) {
      showToast(`设置已保存（${res.status?.httpUrl || ""}）`);
    }
  });

  // One-click global agent registration (`https://agents-chat.com/api/account/register` -> `~/.agentschat/profiles/`)
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

  // `@mention` Autocomplete Popover in Composer
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
      const nameSpan = document.createElement("span");
      nameSpan.textContent = (m.online ? "● " : "") + (m.display_name || m.agent_id);
      const idSpan = document.createElement("span");
      idSpan.className = "mention-opt-id";
      idSpan.textContent = `@${m.agent_id}`;
      opt.appendChild(nameSpan);
      opt.appendChild(idSpan);
      opt.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyMentionSelection(m.agent_id);
      });
      elMentionMenu.appendChild(opt);
    });
    elMentionMenu.hidden = false;
  }

  elInput.addEventListener("input", () => updateMentionMenu());
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
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      sendChatText();
    }
  });

  // Boot
  (async () => {
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
