(function () {
  "use strict";

  const bridge = window.agentschatLocalBridge || null;
  const originUrl = window.location.origin;
  const wsOriginUrl = originUrl.replace(/^http/i, "ws") + "/ws";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Restore saved theme (default = WeChat crisp Light mode)
  try {
    if (localStorage.getItem("ac_desktop_theme") === "dark") {
      document.documentElement.classList.add("dark");
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
  const PINNED_KEY = "ac_local_pinned_channels";
  const pinnedChannelIds = (() => {
    const set = new Set();
    try {
      const parsed = JSON.parse(localStorage.getItem(PINNED_KEY) || "[]");
      if (Array.isArray(parsed)) {
        parsed.slice(0, 100).forEach((id) => {
          if (typeof id === "string" && id.trim()) set.add(id.trim());
        });
      }
    } catch {}
    return set;
  })();
  let sidebarUnreadOnly = false;
  let pendingUnreadBanner = null;
  let ctxMenuEl = null;
  let ctxMenuPrevFocus = null;

  function isImeComposing(ev) {
    return Boolean(ev && (ev.isComposing || ev.keyCode === 229));
  }

  function getOrderedChannels() {
    return channels
      .map((ch, index) => ({ ch, index, pinned: isChannelPinned(ch?.id) }))
      .filter(({ ch }) => Boolean(ch && ch.id))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return a.index - b.index;
      });
  }

  function persistPinnedChannels() {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(Array.from(pinnedChannelIds).slice(0, 100)));
    } catch {}
  }
  function isChannelPinned(channelId) {
    return Boolean(channelId && pinnedChannelIds.has(channelId));
  }
  function toggleChannelPin(channelId) {
    if (!channelId) return false;
    let nowPinned;
    if (pinnedChannelIds.has(channelId)) {
      pinnedChannelIds.delete(channelId);
      nowPinned = false;
    } else {
      pinnedChannelIds.add(channelId);
      nowPinned = true;
    }
    persistPinnedChannels();
    renderChannelList();
    showToast(nowPinned ? "已置顶该会话" : "已取消置顶");
    return nowPinned;
  }
  function getTotalLocalUnread() {
    let total = 0;
    for (const [id, count] of unreadByChannel.entries()) {
      if (id !== currentChannelId && Number(count) > 0) total += Number(count);
    }
    return total;
  }
  function updateUnreadFilterUI() {
    const total = getTotalLocalUnread();
    if (elChFilterAll) {
      elChFilterAll.classList.toggle("active", !sidebarUnreadOnly);
      elChFilterAll.setAttribute("aria-selected", String(!sidebarUnreadOnly));
    }
    if (elChFilterUnread) {
      elChFilterUnread.classList.toggle("active", sidebarUnreadOnly);
      elChFilterUnread.setAttribute("aria-selected", String(sidebarUnreadOnly));
      elChFilterUnread.textContent = total > 0 ? `未读 ${total > 99 ? "99+" : total}` : "未读";
    }
    document.title = total > 0 ? `(${total > 99 ? "99+" : total}) AgentsChat Local Server` : "AgentsChat Local Server";
  }
  function closeChannelContextMenu(restoreFocus = false) {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
    const prev = ctxMenuPrevFocus;
    ctxMenuPrevFocus = null;
    if (restoreFocus && prev && typeof prev.focus === "function" && document.contains(prev)) {
      try { prev.focus(); } catch {}
    }
  }

  function mountContextMenu(menu, clientX, clientY) {
    ctxMenuPrevFocus = document.activeElement;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const x = Math.min(Math.max(8, clientX), Math.max(8, window.innerWidth - rect.width - 8));
    const y = Math.min(Math.max(8, clientY), Math.max(8, window.innerHeight - rect.height - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    ctxMenuEl = menu;

    const getEnabledItems = () =>
      Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));

    menu.addEventListener("keydown", (ev) => {
      const items = getEnabledItems();
      if (!items.length) return;
      const curIdx = items.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        items[(curIdx + 1 + items.length) % items.length]?.focus();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        items[(curIdx <= 0 ? items.length - 1 : curIdx - 1)]?.focus();
      } else if (ev.key === "Home") {
        ev.preventDefault();
        items[0]?.focus();
      } else if (ev.key === "End") {
        ev.preventDefault();
        items[items.length - 1]?.focus();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeChannelContextMenu(true);
      }
    });

    const first = getEnabledItems()[0];
    if (first && typeof first.focus === "function") {
      try { first.focus({ preventScroll: true }); } catch { try { first.focus(); } catch {} }
    }
  }

  function openChannelContextMenu(ch, clientX, clientY) {
    closeChannelContextMenu(false);
    if (!ch || !ch.id) return;
    const menu = document.createElement("div");
    menu.id = "local-ctx-menu";
    menu.className = "local-ctx-menu";
    menu.setAttribute("role", "menu");

    const pinned = isChannelPinned(ch.id);
    const unread = ch.id === currentChannelId ? 0 : (unreadByChannel.get(ch.id) || 0);

    const addItem = (label, onClick, disabled = false) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "local-ctx-item";
      item.setAttribute("role", "menuitem");
      item.disabled = disabled;
      item.textContent = label;
      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeChannelContextMenu(false);
        onClick();
      });
      menu.appendChild(item);
    };

    addItem(pinned ? "📌 取消置顶" : "📌 置顶会话", () => toggleChannelPin(ch.id));
    addItem(unread > 0 ? `✓ 标记已读 (${unread})` : "✓ 标记已读", () => {
      unreadByChannel.delete(ch.id);
      updateUnreadFilterUI();
      renderChannelList();
      showToast("已标为已读");
    }, unread <= 0);

    const sep = document.createElement("div");
    sep.className = "local-ctx-sep";
    menu.appendChild(sep);

    addItem("🔗 复制频道 ID", async () => {
      await copyTextToClipboard(ch.id);
      showToast(`已复制频道 ID: ${ch.id}`);
    });

    mountContextMenu(menu, clientX, clientY);
  }
  document.addEventListener("click", (ev) => {
    if (ctxMenuEl && !ctxMenuEl.contains(ev.target)) closeChannelContextMenu(false);
  });
  window.addEventListener("blur", () => closeChannelContextMenu(false));
  window.addEventListener("resize", () => closeChannelContextMenu(false));
  const draftsByChannel = (() => {
    const map = new Map();
    try {
      const parsed = JSON.parse(sessionStorage.getItem("ac_local_drafts_v1") || "{}");
      if (parsed && typeof parsed === "object") {
        Object.entries(parsed).slice(0, 50).forEach(([k, v]) => {
          if (typeof v === "string" && v.trim()) map.set(k, v.slice(0, 4000));
        });
      }
    } catch {}
    return map;
  })();
  function persistLocalDrafts() {
    try {
      const obj = {};
      let count = 0;
      for (const [k, v] of draftsByChannel.entries()) {
        if (count++ >= 50) break;
        obj[k] = v;
      }
      sessionStorage.setItem("ac_local_drafts_v1", JSON.stringify(obj));
    } catch {}
  }
  function saveLocalDraft(channelId, text) {
    if (!channelId) return;
    const val = typeof text === "string" ? text.slice(0, 4000) : "";
    if (val.trim()) draftsByChannel.set(channelId, val);
    else draftsByChannel.delete(channelId);
    persistLocalDrafts();
  }
  function getLocalDraft(channelId) {
    return (channelId && draftsByChannel.get(channelId)) || "";
  }
  function clearLocalDraft(channelId) {
    if (!channelId || !draftsByChannel.has(channelId)) return;
    draftsByChannel.delete(channelId);
    persistLocalDrafts();
  }
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
  const elChFilterAll = document.getElementById("ch-filter-all");
  const elChFilterUnread = document.getElementById("ch-filter-unread");
  elChFilterAll?.addEventListener("click", () => {
    sidebarUnreadOnly = false;
    updateUnreadFilterUI();
    renderChannelList();
  });
  elChFilterUnread?.addEventListener("click", () => {
    sidebarUnreadOnly = true;
    updateUnreadFilterUI();
    renderChannelList();
  });
  const elBots = document.getElementById("discovered-bots");
  const elBotCountBadge = document.getElementById("bot-count-badge");
  const elRoomTitle = document.getElementById("room-title");
  const elRoomTopic = document.getElementById("room-topic");
  const elMemberStrip = document.getElementById("member-strip");
  const elMessages = document.getElementById("messages-box");
  const elTyping = document.getElementById("typing-bar");
  const elInput = document.getElementById("msg-input");
  const elBtnSend = document.getElementById("btn-send");
  const elToast = document.getElementById("toast");
  const elWsPill = document.getElementById("ws-pill");
  const elSearchInput = document.getElementById("search-input");
  const elSearchBanner = document.getElementById("search-banner");
  const elSearchBannerText = document.getElementById("search-banner-text");
  const elSearchMatchCount = document.getElementById("search-match-count");
  const elBtnSearchPrev = document.getElementById("btn-search-prev");
  const elBtnSearchNext = document.getElementById("btn-search-next");
  const elReplyBanner = document.getElementById("reply-banner");
  const elReplyBannerText = document.getElementById("reply-banner-text");
  const elMentionMenu = document.getElementById("mention-menu");
  const elScrollBtn = document.getElementById("btn-scroll-bottom");
  const elScrollBtnText = document.getElementById("scroll-bottom-text");

  let pendingNewInRoom = 0;
  let searchMatchEls = [];
  let searchMatchIdx = -1;

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
    document.documentElement.classList.toggle("dark", isDark);
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

  async function copyTextToClipboard(text) {
    const val = String(text ?? "");
    try {
      if (bridge?.copyText) {
        await bridge.copyText(val);
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(val);
        return;
      }
    } catch {}
    const ta = document.createElement("textarea");
    ta.value = val;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (authToken) headers.Authorization = "Bearer " + authToken;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    try {
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return {
        ok: false,
        status: 0,
        networkError: true,
        data: { error: "本机服务暂不可达，请稍后重试" },
      };
    }
  }

  function openPromptDialog({ title, hint, placeholder1, placeholder2, value1, multiline }) {
    const dlg = document.getElementById("prompt-dialog");
    const i1 = document.getElementById("dialog-input-1");
    const ta = document.getElementById("dialog-textarea");
    const i2 = document.getElementById("dialog-input-2");
    const confirmBtn = document.getElementById("dialog-confirm");
    const cancelBtn = document.getElementById("dialog-cancel");
    if (confirmBtn) {
      confirmBtn.textContent = "确认";
      confirmBtn.classList.remove("btn-danger");
      confirmBtn.classList.add("btn-primary");
    }
    if (cancelBtn) cancelBtn.textContent = "取消";
    const useMulti = Boolean(multiline && ta);
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-hint").textContent = hint || "";
    if (useMulti) {
      i1.hidden = true;
      i1.style.display = "none";
      ta.hidden = false;
      ta.style.display = "block";
      ta.value = value1 || "";
      ta.placeholder = placeholder1 || "";
      ta.rows = Math.min(10, Math.max(4, String(value1 || "").split("\n").length + 1));
    } else {
      if (ta) {
        ta.hidden = true;
        ta.style.display = "none";
      }
      i1.hidden = false;
      i1.style.display = "block";
      i1.value = value1 || "";
      i1.placeholder = placeholder1 || "";
    }
    if (placeholder2) {
      i2.style.display = "block";
      i2.value = "";
      i2.placeholder = placeholder2;
    } else {
      i2.style.display = "none";
    }
    const activeField = useMulti ? ta : i1;
    const prevFocus = document.activeElement;
    return new Promise((resolve) => {
      const form = document.getElementById("dialog-form");
      const cancelBtn = document.getElementById("dialog-cancel");
      const onFieldKey = (ev) => {
        if (ev.key === "Enter" && isImeComposing(ev)) {
          ev.preventDefault();
          return;
        }
        if (useMulti && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !isImeComposing(ev)) {
          ev.preventDefault();
          onSubmit(ev);
        }
      };
      const restoreFocus = () => {
        if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
          try { prevFocus.focus(); } catch {}
        }
      };
      const onDialogCancel = (ev) => {
        ev.preventDefault();
        onCancel();
      };
      const onDialogClose = () => {
        cleanup();
        restoreFocus();
        resolve(null);
      };
      const cleanup = () => {
        form.removeEventListener("submit", onSubmit);
        cancelBtn.removeEventListener("click", onCancel);
        dlg.removeEventListener("cancel", onDialogCancel);
        dlg.removeEventListener("close", onDialogClose);
        activeField.removeEventListener("keydown", onFieldKey);
      };
      const onSubmit = (ev) => {
        ev.preventDefault();
        cleanup();
        dlg.close();
        restoreFocus();
        resolve({ v1: activeField.value.trim(), v2: i2.value.trim() });
      };
      const onCancel = () => {
        cleanup();
        dlg.close();
        restoreFocus();
        resolve(null);
      };
      form.addEventListener("submit", onSubmit);
      cancelBtn.addEventListener("click", onCancel);
      dlg.addEventListener("cancel", onDialogCancel);
      dlg.addEventListener("close", onDialogClose);
      activeField.addEventListener("keydown", onFieldKey);
      dlg.showModal();
      activeField.focus();
      if (value1 && !useMulti) activeField.select();
    });
  }

  function openConfirmDialog({ title, hint, confirmText = "确认", cancelText = "取消", danger = false }) {
    const dlg = document.getElementById("prompt-dialog");
    const i1 = document.getElementById("dialog-input-1");
    const ta = document.getElementById("dialog-textarea");
    const i2 = document.getElementById("dialog-input-2");
    const confirmBtn = document.getElementById("dialog-confirm");
    const cancelBtn = document.getElementById("dialog-cancel");
    if (!dlg) return Promise.resolve(false);
    document.getElementById("dialog-title").textContent = title || "确认操作";
    document.getElementById("dialog-hint").textContent = hint || "";
    if (i1) {
      i1.hidden = true;
      i1.style.display = "none";
      i1.value = "";
    }
    if (ta) {
      ta.hidden = true;
      ta.style.display = "none";
      ta.value = "";
    }
    if (i2) {
      i2.style.display = "none";
      i2.value = "";
    }
    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.classList.toggle("btn-danger", Boolean(danger));
      confirmBtn.classList.toggle("btn-primary", !danger);
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;
    const prevFocus = document.activeElement;
    return new Promise((resolve) => {
      const form = document.getElementById("dialog-form");
      let settled = false;
      const restore = () => {
        if (confirmBtn) {
          confirmBtn.textContent = "确认";
          confirmBtn.classList.remove("btn-danger");
          confirmBtn.classList.add("btn-primary");
        }
        if (cancelBtn) cancelBtn.textContent = "取消";
      };
      const onFormKey = (ev) => {
        if (ev.key === "Enter" && !isImeComposing(ev) && cancelBtn && document.activeElement === cancelBtn) {
          ev.preventDefault();
          finish(false);
        }
      };
      const cleanup = () => {
        form.removeEventListener("submit", onSubmit);
        form.removeEventListener("keydown", onFormKey);
        cancelBtn?.removeEventListener("click", onCancel);
        dlg.removeEventListener("cancel", onDialogCancel);
        dlg.removeEventListener("close", onDialogClose);
        restore();
      };
      const finish = (accepted) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (dlg.open) dlg.close();
        if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
          try { prevFocus.focus(); } catch {}
        }
        resolve(accepted);
      };
      const onSubmit = (ev) => {
        ev.preventDefault();
        finish(true);
      };
      const onCancel = () => finish(false);
      const onDialogCancel = (ev) => {
        ev.preventDefault();
        finish(false);
      };
      const onDialogClose = () => finish(false);
      form.addEventListener("submit", onSubmit);
      form.addEventListener("keydown", onFormKey);
      cancelBtn?.addEventListener("click", onCancel);
      dlg.addEventListener("cancel", onDialogCancel);
      dlg.addEventListener("close", onDialogClose);
      dlg.showModal();
      (danger && cancelBtn ? cancelBtn : confirmBtn || cancelBtn)?.focus();
    });
  }

  let _localDialogDownTarget = null;
  document.addEventListener("mousedown", (ev) => {
    _localDialogDownTarget = ev.target;
  }, true);

  function openNativeDialog(dlg) {
    if (!dlg || typeof dlg.showModal !== "function") return;
    const prevFocus = document.activeElement;
    if (dlg.dataset.focusRestoreBound !== "1") {
      dlg.dataset.focusRestoreBound = "1";
      dlg.addEventListener("close", () => {
        const prev = dlg._prevFocus;
        dlg._prevFocus = null;
        if (prev && typeof prev.focus === "function" && document.contains(prev)) {
          try { prev.focus(); } catch {}
        }
      });
    }
    dlg._prevFocus = prevFocus;
    dlg.showModal();
  }

  function flashCopyButton(btn, defaultLabel) {
    if (!btn) return;
    const baseLabel = btn.dataset.defaultLabel || defaultLabel || btn.textContent || "复制";
    btn.dataset.defaultLabel = baseLabel;
    btn.textContent = "✓ 已复制";
    clearTimeout(btn._copyFlashTimer);
    btn._copyFlashTimer = setTimeout(() => {
      btn.textContent = baseLabel;
    }, 1400);
  }

  function bindDialogBackdropClose(dlg) {
    if (!dlg || dlg.dataset.backdropBound === "1") return;
    dlg.dataset.backdropBound = "1";
    dlg.addEventListener("click", (ev) => {
      const downTarget = _localDialogDownTarget;
      _localDialogDownTarget = null;
      if (ev.target !== dlg) return;
      if (downTarget && downTarget !== dlg) return;
      if (ev.detail === 0 && ev.clientX === 0 && ev.clientY === 0) return;
      const rect = dlg.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const inside =
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;
      if (!inside) {
        const cancelEv = new Event("cancel", { cancelable: true });
        if (dlg.dispatchEvent(cancelEv)) {
          dlg.close("cancel");
        }
      }
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
    elWsPill.classList.remove("live", "reconnecting", "clickable");
    if (state === "live") {
      elWsPill.classList.add("live");
      elWsPill.textContent = "实时已连";
      elWsPill.title = "本机 WebSocket 实时通道已连接";
      elWsPill.removeAttribute("role");
      elWsPill.removeAttribute("tabindex");
    } else if (state === "reconnecting") {
      elWsPill.classList.add("reconnecting", "clickable");
      elWsPill.textContent = "重连中…";
      elWsPill.title = "点击立即重试连接本机实时通道";
      elWsPill.setAttribute("role", "button");
      elWsPill.setAttribute("tabindex", "0");
    } else {
      elWsPill.classList.add("clickable");
      elWsPill.textContent = "离线";
      elWsPill.title = "本机实时通道离线 — 点击立即重连";
      elWsPill.setAttribute("role", "button");
      elWsPill.setAttribute("tabindex", "0");
    }
  }

  function triggerManualWsReconnect() {
    if (!elWsPill || elWsPill.classList.contains("live")) return;
    if (!authToken) {
      showToast("请先同步或填入全局账号凭证");
      return;
    }
    showToast("正在重新连接本机实时通道…");
    connectRealtimeWs();
  }
  elWsPill?.addEventListener("click", triggerManualWsReconnect);
  elWsPill?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      triggerManualWsReconnect();
    }
  });

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
          updateUnreadFilterUI();
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
        if (frame.agent_id) {
          knownBotOnlineById.set(frame.agent_id, online);
          updateDiscoveredBotPresence(frame.agent_id, online);
        }
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

  window.addEventListener("online", () => {
    if (!authToken) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      wsReconnectDelayMs = 1000;
      connectRealtimeWs();
    }
  });

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

  function renderChannelList() {
    updateUnreadFilterUI();
    elChannelList.replaceChildren();
    const ordered = getOrderedChannels().filter(({ ch }) => {
      if (!sidebarUnreadOnly) return true;
      return ch.id !== currentChannelId && (unreadByChannel.get(ch.id) || 0) > 0;
    });

    if (ordered.length === 0 && sidebarUnreadOnly) {
      const empty = document.createElement("div");
      empty.className = "ch-filter-empty";
      const txt = document.createElement("span");
      txt.textContent = "全部消息已读 🎉";
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "btn btn-ghost btn-xs";
      backBtn.textContent = "查看全部会话";
      backBtn.addEventListener("click", () => {
        sidebarUnreadOnly = false;
        updateUnreadFilterUI();
        renderChannelList();
      });
      empty.appendChild(txt);
      empty.appendChild(backBtn);
      elChannelList.appendChild(empty);
      return;
    }

    ordered.forEach(({ ch, pinned }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const isCurrent = ch.id === currentChannelId;
      btn.className =
        "channel-item" +
        (isCurrent ? " active" : "") +
        (pinned ? " pinned" : "");
      btn.dataset.channelId = ch.id;
      if (isCurrent) btn.setAttribute("aria-current", "page");

      const displayLabel = ch.type === "direct" ? (ch.name || ch.id) : `#${ch.name || ch.id}`;
      const unread = unreadByChannel.get(ch.id) || 0;
      const draftText = !isCurrent ? getLocalDraft(ch.id) : "";
      const ariaParts = [displayLabel];
      if (pinned) ariaParts.push("已置顶");
      if (unread > 0 && !isCurrent) ariaParts.push(`${unread} 条未读`);
      if (draftText) ariaParts.push("有草稿");
      btn.setAttribute("aria-label", ariaParts.join("，"));

      const av = document.createElement("div");
      av.className = "ch-avatar";
      av.style.background = avatarBg(ch.id);
      if (ch.type === "direct") {
        av.textContent = avatarInitials(ch.name, ch.id);
      } else {
        av.appendChild(createSvgIcon(ch.visibility === "private" ? "lock" : "hash"));
      }
      if (unread > 0 && !isCurrent) {
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
      name.textContent = displayLabel;
      top.appendChild(name);
      if (pinned) {
        const pin = document.createElement("span");
        pin.className = "ch-pin-mark";
        pin.title = "已置顶（右键取消）";
        pin.textContent = "📌";
        top.appendChild(pin);
      }
      if (ch.member_count !== undefined && ch.member_count !== null) {
        const count = document.createElement("span");
        count.className = "ch-count";
        count.textContent = `${ch.member_count}人`;
        top.appendChild(count);
      }
      const sub = document.createElement("div");
      sub.className = "ch-sub";
      if (draftText) {
        const tag = document.createElement("span");
        tag.className = "ch-draft-prefix";
        tag.textContent = "[草稿]";
        sub.appendChild(tag);
        sub.appendChild(document.createTextNode(draftText.replace(/\s+/g, " ").slice(0, 48)));
      } else {
        sub.textContent = ch.topic || (ch.type === "direct" ? "1v1 本机私聊" : "本机多 Agent 群聊");
      }
      body.appendChild(top);
      body.appendChild(sub);

      btn.appendChild(av);
      btn.appendChild(body);
      btn.addEventListener("click", () => selectChannel(ch.id));
      btn.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openChannelContextMenu(ch, ev.clientX, ev.clientY);
      });
      elChannelList.appendChild(btn);
    });
  }

  async function loadChannels() {
    const res = await api("/api/channels");
    channels = Array.isArray(res.data?.channels) ? res.data.channels : [];
    renderChannelList();
  }

  const knownBotOnlineById = new Map();
  let discoveredProfilesCache = [];

  function renderBotCountBadge() {
    if (!elBotCountBadge) return;
    const total = discoveredProfilesCache.length;
    if (total === 0) {
      elBotCountBadge.hidden = true;
      elBotCountBadge.textContent = "";
      elBotCountBadge.classList.remove("has-online");
      return;
    }
    const online = discoveredProfilesCache.filter((p) => Boolean(knownBotOnlineById.get(p.agent_id))).length;
    elBotCountBadge.hidden = false;
    elBotCountBadge.classList.toggle("has-online", online > 0);
    elBotCountBadge.textContent = online > 0 ? `${online}/${total} 在线` : String(total);
    elBotCountBadge.title = online > 0 ? `已检测到 ${total} 个本机 Agent，${online} 个在线` : `已检测到 ${total} 个本机 Agent`;
  }

  function updateDiscoveredBotPresence(agentId, online) {
    if (!elBots || !agentId) return;
    const rows = elBots.querySelectorAll(".bot-row");
    for (const row of rows) {
      if (row.dataset.agentId === agentId) {
        const ind = row.querySelector(".bot-online-dot");
        if (ind) {
          ind.classList.toggle("online", Boolean(online));
          ind.title = online ? "在线" : "离线";
        }
      }
    }
    renderBotCountBadge();
  }

  async function loadDiscoveredBots() {
    const res = await api("/api/local/discovered-profiles");
    const profiles = Array.isArray(res.data?.profiles) ? res.data.profiles : [];
    const principals = Array.isArray(res.data?.known_principals) ? res.data.known_principals : [];
    for (const kp of principals) {
      if (kp && typeof kp.id === "string") {
        knownBotOnlineById.set(kp.id, Boolean(kp.online));
      }
    }
    discoveredProfilesCache = profiles.slice().sort((a, b) => {
      const ao = Boolean(knownBotOnlineById.get(a.agent_id));
      const bo = Boolean(knownBotOnlineById.get(b.agent_id));
      if (ao !== bo) return ao ? -1 : 1;
      return String(a.display_name || a.agent_id || "").localeCompare(
        String(b.display_name || b.agent_id || ""),
        undefined,
        { sensitivity: "base" },
      );
    });
    renderBotCountBadge();
    elBots.replaceChildren();
    if (discoveredProfilesCache.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bot-empty";
      empty.textContent = "未检测到 ~/.agentschat 下的本地 Profile，可点击上方「＋注册」快速创建。";
      elBots.appendChild(empty);
      return;
    }
    discoveredProfilesCache.forEach((p) => {
      const isOnline = Boolean(knownBotOnlineById.get(p.agent_id));
      const row = document.createElement("div");
      row.className = "bot-row";
      row.dataset.agentId = p.agent_id;

      const meta = document.createElement("div");
      meta.className = "bot-meta";
      const dot = document.createElement("span");
      dot.className = "bot-dot";
      dot.style.background = avatarBg(p.agent_id);
      dot.textContent = avatarInitials(p.display_name, p.agent_id);
      const statusDot = document.createElement("span");
      statusDot.className = "bot-online-dot" + (isOnline ? " online" : "");
      statusDot.title = isOnline ? "在线" : "离线";
      dot.appendChild(statusDot);

      const copy = document.createElement("div");
      copy.className = "bot-copy";
      const nameEl = document.createElement("div");
      nameEl.className = "bot-name";
      nameEl.textContent = p.display_name;
      const idEl = document.createElement("div");
      idEl.className = "bot-id copyable";
      idEl.textContent = `@${p.agent_id}`;
      idEl.setAttribute("role", "button");
      idEl.setAttribute("tabindex", "0");
      idEl.setAttribute("aria-label", `复制 @${p.agent_id}`);
      idEl.title = "点击复制 @ID";
      const copyBotHandle = async (ev) => {
        ev.stopPropagation();
        const handle = `@${p.agent_id}`;
        if (bridge?.copyText) await bridge.copyText(handle);
        else await navigator.clipboard?.writeText(handle);
        showToast(`已复制 ${handle}`);
      };
      idEl.addEventListener("click", copyBotHandle);
      idEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          void copyBotHandle(ev);
        }
      });
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
        if (btnInvite.disabled) return;
        btnInvite.disabled = true;
        btnInvite.textContent = "处理中…";
        btnInvite.setAttribute("aria-busy", "true");
        try {
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
        } finally {
          btnInvite.disabled = false;
          btnInvite.textContent = "入群";
          btnInvite.removeAttribute("aria-busy");
        }
      });

      const btnDm = document.createElement("button");
      btnDm.type = "button";
      btnDm.className = "icon-btn";
      btnDm.textContent = "私聊";
      btnDm.title = "打开与该本机 Agent 的 1v1 私聊";
      btnDm.addEventListener("click", async () => {
        if (btnDm.disabled) return;
        btnDm.disabled = true;
        btnDm.textContent = "打开中…";
        btnDm.setAttribute("aria-busy", "true");
        try {
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
        } finally {
          btnDm.disabled = false;
          btnDm.textContent = "私聊";
          btnDm.removeAttribute("aria-busy");
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
        flashCopyButton(btnCmd, "MCP");
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

  let channelLoadSeq = 0;
  let isSendingChat = false;

  function autoResizeLocalInput() {
    if (!elInput) return;
    elInput.style.height = "auto";
    const nextHeight = Math.min(180, Math.max(62, elInput.scrollHeight || 62));
    elInput.style.height = `${nextHeight}px`;
  }

  function syncComposerState() {
    autoResizeLocalInput();
    if (elBtnSend && elInput) {
      elBtnSend.disabled = isSendingChat || !String(elInput.value || "").trim();
      elBtnSend.textContent = isSendingChat ? "发送中…" : "发送";
    }
  }

  function renderMessagesSkeleton() {
    if (!elMessages) return;
    elMessages.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "msg-skeleton-list";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-label", "正在加载房间消息");
    const shapes = [
      { self: false, width: "220px", height: "48px" },
      { self: true, width: "168px", height: "42px" },
      { self: false, width: "268px", height: "58px" },
    ];
    for (const s of shapes) {
      const row = document.createElement("div");
      row.className = "msg-skel-row" + (s.self ? " self" : "");
      const av = document.createElement("div");
      av.className = "msg-skel-avatar";
      const bub = document.createElement("div");
      bub.className = "msg-skel-bubble";
      bub.style.width = s.width;
      bub.style.height = s.height;
      row.appendChild(av);
      row.appendChild(bub);
      wrap.appendChild(row);
    }
    elMessages.appendChild(wrap);
  }

  function insertTextAtCursor(textarea, insertion) {
    if (!textarea) return;
    const val = textarea.value || "";
    const start = typeof textarea.selectionStart === "number" ? textarea.selectionStart : val.length;
    const end = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : val.length;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const needsLeadSpace = before.length > 0 && !/\s$/.test(before);
    const piece = (needsLeadSpace ? " " : "") + insertion;
    textarea.value = before + piece + after;
    const caret = before.length + piece.length;
    textarea.focus();
    try { textarea.setSelectionRange(caret, caret); } catch {}
    textarea.dispatchEvent(new Event("input"));
  }

  function markAllLocalChannelsRead() {
    if (unreadByChannel.size === 0) {
      showToast("本机全部会话均已读");
      return;
    }
    unreadByChannel.clear();
    pendingUnreadBanner = null;
    updateUnreadFilterUI();
    renderChannelList();
    showToast("已将本机全部未读标为已读");
  }

  async function selectChannel(channelId) {
    const seq = ++channelLoadSeq;
    const prevChannelId = currentChannelId;
    if (prevChannelId && prevChannelId !== channelId && elInput) {
      saveLocalDraft(prevChannelId, elInput.value);
    }
    currentChannelId = channelId;
    try {
      const nextHash = `#channel=${encodeURIComponent(channelId)}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    } catch {}
    if (elInput && prevChannelId !== channelId) {
      elInput.value = getLocalDraft(channelId);
      syncComposerState();
    }
    const prevUnread = prevChannelId !== channelId ? (unreadByChannel.get(channelId) || 0) : 0;
    pendingUnreadBanner = prevUnread > 0 ? { channelId, count: prevUnread } : null;
    unreadByChannel.delete(channelId);
    updateUnreadFilterUI();
    activeSearchQuery = "";
    if (elSearchInput) elSearchInput.value = "";
    if (elSearchBanner) elSearchBanner.hidden = true;
    setReplyTarget(null);
    if (prevChannelId !== channelId && authToken) {
      renderMessagesSkeleton();
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "join_channel", channel_id: channelId })); } catch {}
    }
    await loadChannels();
    if (seq !== channelLoadSeq || currentChannelId !== channelId) return;
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
    if (seq !== channelLoadSeq || currentChannelId !== channelId) return;
    currentMembers = Array.isArray(memRes.data?.members) ? memRes.data.members : [];
    messages = Array.isArray(msgRes.data?.messages) ? msgRes.data.messages : [];
    hasMoreOlder = messages.length >= 50;
    renderMembers();
    renderMessages();
  }

  async function loadOlderMessages(triggerBtn) {
    if (!authToken || loadingOlder || !hasMoreOlder || messages.length === 0 || activeSearchQuery) return;
    loadingOlder = true;
    const oldestTs = messages[0]?.timestamp;
    if (!oldestTs) {
      loadingOlder = false;
      return;
    }
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = "加载中…";
      triggerBtn.setAttribute("aria-busy", "true");
    }
    const prevHeight = elMessages.scrollHeight;
    let res;
    try {
      res = await api(
        `/api/channels/${encodeURIComponent(currentChannelId)}/messages?limit=50&before=${encodeURIComponent(oldestTs)}`,
      );
    } finally {
      loadingOlder = false;
    }
    if (!res?.ok) {
      if (triggerBtn && document.contains(triggerBtn)) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = "查看更多消息";
        triggerBtn.removeAttribute("aria-busy");
      }
      showToast(res?.data?.error || "加载历史消息失败，请稍后重试");
      return;
    }
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
    if (!currentMembers.length) return;
    const sorted = [...currentMembers].sort((a, b) => {
      if (Boolean(a.online) !== Boolean(b.online)) return a.online ? -1 : 1;
      return String(a.display_name || a.agent_id || "").localeCompare(
        String(b.display_name || b.agent_id || ""),
        undefined,
        { sensitivity: "base" },
      );
    });
    const onlineCount = sorted.filter((m) => m.online).length;
    const summary = document.createElement("span");
    summary.className = "member-online-summary";
    summary.textContent = `${onlineCount}/${sorted.length} 在线`;
    summary.title = `当前频道共 ${sorted.length} 位成员，${onlineCount} 位在线`;
    elMemberStrip.appendChild(summary);

    sorted.forEach((m) => {
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
      pill.title = "点击插入 @提及 · 右键或 Option+点击复制 @ID";
      pill.setAttribute(
        "aria-label",
        `${m.display_name || m.agent_id} (@${m.agent_id})，${m.online ? "在线" : "离线"}，点击插入提及`,
      );
      const copyMemberId = async (ev) => {
        ev.preventDefault();
        const handle = `@${m.agent_id}`;
        if (bridge?.copyText) await bridge.copyText(handle);
        else await navigator.clipboard?.writeText(handle);
        showToast(`已复制 ${handle}`);
      };
      pill.addEventListener("click", (ev) => {
        if (ev.altKey) {
          void copyMemberId(ev);
          return;
        }
        insertTextAtCursor(elInput, `@${m.agent_id} `);
      });
      pill.addEventListener("contextmenu", copyMemberId);
      elMemberStrip.appendChild(pill);
    });
  }

  const LOCAL_SYN_TOKEN =
    /((?<!:)\/\/[^\n]*|(?:^|(?<=\s))#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(\d+(?:\.\d+)?)\b|\b(function|const|let|var|if|else|for|while|return|import|export|class|def|self|from|async|await|try|catch|throw|new|switch|case|break|continue|yield|struct|enum|protocol|guard|nil|null|undefined|true|false|print|println)\b/gm;

  function appendSyntaxHighlightedCode(codeEl, rawCode) {
    const src = String(rawCode || "");
    LOCAL_SYN_TOKEN.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = LOCAL_SYN_TOKEN.exec(src)) !== null) {
      if (m.index > last) {
        codeEl.appendChild(document.createTextNode(src.slice(last, m.index)));
      }
      const span = document.createElement("span");
      span.className = m[1] ? "syn-cm" : m[2] ? "syn-str" : m[3] ? "syn-num" : "syn-kw";
      span.textContent = m[0];
      codeEl.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < src.length) {
      codeEl.appendChild(document.createTextNode(src.slice(last)));
    }
  }

  function isMentionMe(handle) {
    const clean = String(handle || "").replace(/^@/, "").toLowerCase();
    if (!clean || !currentPrincipal) return false;
    const pid = String(currentPrincipal.id || "").toLowerCase();
    const pname = String(currentPrincipal.display_name || currentPrincipal.name || "").toLowerCase();
    return Boolean((pid && clean === pid) || (pname && clean === pname));
  }

  function isSafeLocalImageUrl(raw) {
    if (typeof raw !== "string") return false;
    const s = raw.trim();
    if (!s || /[\u0000-\u001f\u007f]/.test(s)) return false;
    if (s.startsWith("//")) return false;
    if (s.startsWith("/")) return true;
    return /^(?:https?:|blob:)/i.test(s);
  }

  // Pure-DOM Pro Image Lightbox 2.0 (focal zoom, smooth trackpad pinch, clamped 2D pan, 1:1, rotate & filmstrip)
  const localLbState = {
    open: false,
    items: [],
    index: 0,
    scale: 1,
    rotate: 0,
    tx: 0,
    ty: 0,
    dragging: false,
    justDragged: false,
    stageDownTarget: null,
    prevFocus: null,
    dragStartX: 0,
    dragStartY: 0,
    originTx: 0,
    originTy: 0,
  };
  let localLbDom = null;
  let localLbWheelTimer = null;

  function lbClampScale(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return 1;
    return Math.min(5, Math.max(0.25, Math.round(n * 100) / 100));
  }

  function lbStageMetrics() {
    if (!localLbDom) return { baseW: 0, baseH: 0, stageW: 0, stageH: 0, cx: 0, cy: 0 };
    const sr = localLbDom.stage.getBoundingClientRect();
    return {
      baseW: localLbDom.img.offsetWidth || 0,
      baseH: localLbDom.img.offsetHeight || 0,
      stageW: sr.width || 0,
      stageH: sr.height || 0,
      cx: sr.left + sr.width / 2,
      cy: sr.top + sr.height / 2,
    };
  }

  function lbClampPan(tx, ty, scale) {
    const s = lbClampScale(scale);
    if (s <= 1.01) return { tx: 0, ty: 0 };
    const m = lbStageMetrics();
    if (!m.baseW || !m.baseH || !m.stageW || !m.stageH) return { tx: Math.round(tx), ty: Math.round(ty) };
    const swapped = localLbState.rotate === 90 || localLbState.rotate === 270;
    const effW = (swapped ? m.baseH : m.baseW) * s;
    const effH = (swapped ? m.baseW : m.baseH) * s;
    const maxX = Math.max(0, (effW - m.stageW) / 2);
    const maxY = Math.max(0, (effH - m.stageH) / 2);
    return {
      tx: Math.round(Math.max(-maxX, Math.min(maxX, tx)) * 10) / 10,
      ty: Math.round(Math.max(-maxY, Math.min(maxY, ty)) * 10) / 10,
    };
  }

  function lbApplyTransform(instant) {
    if (!localLbDom) return;
    const img = localLbDom.img;
    if (instant) {
      img.classList.add("instant");
      clearTimeout(localLbWheelTimer);
      localLbWheelTimer = setTimeout(() => {
        if (localLbDom) localLbDom.img.classList.remove("instant");
      }, 90);
    } else {
      img.classList.remove("instant");
    }
    img.style.transform = `translate3d(${localLbState.tx}px,${localLbState.ty}px,0) scale(${localLbState.scale}) rotate(${localLbState.rotate}deg)`;
    img.classList.toggle("zoomed", localLbState.scale > 1.01);
    localLbDom.pctBtn.textContent = `${Math.round(localLbState.scale * 100)}%`;
    localLbDom.oneBtn.classList.toggle("active", localLbState.scale > 1.05);
  }

  function lbSetScaleAt(nextScale, clientX, clientY, instant) {
    const cur = localLbState.scale;
    const next = lbClampScale(nextScale);
    if (next <= 1.01) {
      localLbState.scale = next;
      localLbState.tx = 0;
      localLbState.ty = 0;
      lbApplyTransform(!!instant);
      return;
    }
    const m = lbStageMetrics();
    const fx = typeof clientX === "number" && m.stageW > 0 ? clientX - m.cx : 0;
    const fy = typeof clientY === "number" && m.stageH > 0 ? clientY - m.cy : 0;
    const ratio = next / cur;
    const cl = lbClampPan(fx - (fx - localLbState.tx) * ratio, fy - (fy - localLbState.ty) * ratio, next);
    localLbState.scale = next;
    localLbState.tx = cl.tx;
    localLbState.ty = cl.ty;
    lbApplyTransform(!!instant);
  }

  function lbResetTransform() {
    localLbState.scale = 1;
    localLbState.rotate = 0;
    localLbState.tx = 0;
    localLbState.ty = 0;
    lbApplyTransform(false);
  }

  function lbUpdateMeta() {
    if (!localLbDom || !localLbState.items.length) return;
    const cur = localLbState.items[localLbState.index] || localLbState.items[0];
    const parts = [];
    if (localLbDom.img.naturalWidth > 0 && localLbDom.img.naturalHeight > 0) {
      parts.push(`${localLbDom.img.naturalWidth} × ${localLbDom.img.naturalHeight}`);
    }
    if (cur.alt && cur.alt.toLowerCase() !== "image") {
      parts.push(cur.alt.length > 30 ? cur.alt.slice(0, 29) + "…" : cur.alt);
    }
    if (parts.length) {
      localLbDom.meta.textContent = parts.join(" · ");
      localLbDom.meta.style.display = "inline-flex";
    } else {
      localLbDom.meta.style.display = "none";
    }
  }

  function lbUpdateView() {
    if (!localLbDom || !localLbState.items.length) return;
    const cur = localLbState.items[localLbState.index] || localLbState.items[0];
    localLbDom.img.src = cur.src;
    localLbDom.img.alt = cur.alt || "";
    lbResetTransform();
    lbUpdateMeta();

    const multi = localLbState.items.length > 1;
    localLbDom.root.classList.toggle("has-strip", multi);
    localLbDom.counter.style.display = multi ? "inline-flex" : "none";
    localLbDom.counter.textContent = `${localLbState.index + 1} / ${localLbState.items.length}`;
    localLbDom.prevBtn.style.display = multi ? "flex" : "none";
    localLbDom.nextBtn.style.display = multi ? "flex" : "none";
    localLbDom.prevBtn.disabled = localLbState.index <= 0;
    localLbDom.nextBtn.disabled = localLbState.index >= localLbState.items.length - 1;

    localLbDom.strip.replaceChildren();
    if (multi) {
      localLbState.items.forEach((item, idx) => {
        const tb = document.createElement("button");
        tb.type = "button";
        tb.className = "local-lb-thumb" + (idx === localLbState.index ? " active" : "");
        tb.setAttribute("aria-label", `图片 ${idx + 1}`);
        const ti = document.createElement("img");
        ti.src = item.src;
        ti.alt = "";
        ti.loading = "lazy";
        ti.draggable = false;
        tb.appendChild(ti);
        tb.addEventListener("click", (e) => {
          e.stopPropagation();
          if (localLbState.index !== idx) {
            localLbState.index = idx;
            lbUpdateView();
          }
        });
        localLbDom.strip.appendChild(tb);
      });
    }
  }

  function lbStep(delta) {
    if (!localLbState.open || localLbState.items.length <= 1) return;
    const next = localLbState.index + delta;
    if (next < 0 || next >= localLbState.items.length) return;
    localLbState.index = next;
    lbUpdateView();
  }

  async function lbCopyImage() {
    const cur = localLbState.items[localLbState.index];
    if (!cur || !isSafeLocalImageUrl(cur.src)) return;
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const resp = await fetch(cur.src);
        const blob = await resp.blob();
        let pngBlob = blob;
        if (blob.type !== "image/png" && typeof createImageBitmap === "function") {
          const bmp = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext("2d").drawImage(bmp, 0, 0);
          pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        }
        if (pngBlob) {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
          showToast("已复制图片到剪贴板");
          return;
        }
      }
      await copyTextToClipboard(cur.src);
      showToast("已复制图片链接");
    } catch {
      await copyTextToClipboard(cur.src);
      showToast("已复制图片链接");
    }
  }

  function lbDownloadImage() {
    const cur = localLbState.items[localLbState.index];
    if (!cur || !isSafeLocalImageUrl(cur.src)) return;
    const clean = cur.src.split("?")[0].split("#")[0];
    const last = (clean.split("/").pop() || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
    const name = last && /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(last) ? last : "agentschat-image.png";
    const a = document.createElement("a");
    a.href = cur.src;
    a.download = name;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function closeLocalImageLightbox() {
    if (!localLbState.open) return;
    localLbState.open = false;
    localLbState.dragging = false;
    localLbState.justDragged = false;
    localLbState.stageDownTarget = null;
    if (localLbDom) {
      localLbDom.root.classList.remove("open");
      localLbDom.img.src = "";
    }
    const prev = localLbState.prevFocus;
    localLbState.prevFocus = null;
    if (prev && typeof prev.focus === "function" && document.contains(prev)) {
      try { prev.focus(); } catch {}
    }
  }

  function ensureLocalLightboxDom() {
    if (localLbDom && localLbDom.root.isConnected) return localLbDom;
    const root = document.createElement("div");
    root.id = "localImageLightbox";
    root.className = "local-lb-backdrop";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "图片查看器");

    const topbar = document.createElement("div");
    topbar.className = "local-lb-topbar";
    const topLeft = document.createElement("div");
    topLeft.className = "local-lb-top-left";
    const counter = document.createElement("span");
    counter.className = "local-lb-counter";
    const meta = document.createElement("span");
    meta.className = "local-lb-meta";
    meta.style.display = "none";
    topLeft.append(counter, meta);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "local-lb-close";
    closeBtn.setAttribute("aria-label", "关闭图片查看器");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", closeLocalImageLightbox);
    topbar.append(topLeft, closeBtn);

    const stage = document.createElement("div");
    stage.className = "local-lb-stage";
    const img = document.createElement("img");
    img.className = "local-lb-img";
    img.draggable = false;
    img.addEventListener("load", lbUpdateMeta);
    stage.appendChild(img);

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "local-lb-nav local-lb-prev";
    prevBtn.setAttribute("aria-label", "上一张图片");
    prevBtn.textContent = "‹";
    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); lbStep(-1); });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "local-lb-nav local-lb-next";
    nextBtn.setAttribute("aria-label", "下一张图片");
    nextBtn.textContent = "›";
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); lbStep(1); });

    const dock = document.createElement("div");
    dock.className = "local-lb-dock";
    const strip = document.createElement("div");
    strip.className = "local-lb-strip";
    strip.addEventListener("click", (e) => e.stopPropagation());
    const toolbar = document.createElement("div");
    toolbar.className = "local-lb-toolbar";
    toolbar.addEventListener("click", (e) => e.stopPropagation());

    const mkBtn = (cls, label, title, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "local-lb-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener("click", onClick);
      return b;
    };
    const mkSep = () => {
      const s = document.createElement("span");
      s.className = "local-lb-sep";
      return s;
    };

    const zoomOutBtn = mkBtn("", "−", "缩小 (-)", () => lbSetScaleAt(localLbState.scale - 0.25, null, null, false));
    const pctBtn = mkBtn("local-lb-pct", "100%", "还原适应屏幕 (0)", lbResetTransform);
    const zoomInBtn = mkBtn("", "+", "放大 (+)", () => lbSetScaleAt(localLbState.scale + 0.25, null, null, false));
    const oneBtn = mkBtn("", "1:1", "原尺寸 / 适应屏幕切换 (1)", () => {
      if (localLbState.scale > 1.05) {
        localLbState.scale = 1; localLbState.tx = 0; localLbState.ty = 0; lbApplyTransform(false);
      } else {
        lbSetScaleAt(2.5, null, null, false);
      }
    });
    const rotLeftBtn = mkBtn("", "↺", "逆时针旋转 90° (Shift+R)", () => {
      localLbState.rotate = (localLbState.rotate + 270) % 360;
      const cl = lbClampPan(localLbState.tx, localLbState.ty, localLbState.scale);
      localLbState.tx = cl.tx; localLbState.ty = cl.ty;
      lbApplyTransform(false);
    });
    const rotRightBtn = mkBtn("", "↻", "顺时针旋转 90° (R)", () => {
      localLbState.rotate = (localLbState.rotate + 90) % 360;
      const cl = lbClampPan(localLbState.tx, localLbState.ty, localLbState.scale);
      localLbState.tx = cl.tx; localLbState.ty = cl.ty;
      lbApplyTransform(false);
    });
    const copyBtn = mkBtn("", "📋 复制", "复制图片 (C)", () => { void lbCopyImage(); });
    const dlBtn = mkBtn("", "⬇ 下载", "下载图片 (D)", lbDownloadImage);
    toolbar.append(zoomOutBtn, pctBtn, zoomInBtn, oneBtn, mkSep(), rotLeftBtn, rotRightBtn, mkSep(), copyBtn, dlBtn);
    dock.append(strip, toolbar);

    stage.addEventListener("mousedown", (e) => {
      localLbState.stageDownTarget = e.target;
      localLbState.justDragged = false;
    });
    stage.addEventListener("click", (e) => {
      const downTarget = localLbState.stageDownTarget;
      localLbState.stageDownTarget = null;
      if (localLbState.justDragged) {
        localLbState.justDragged = false;
        return;
      }
      if (e.target === stage && downTarget === stage) closeLocalImageLightbox();
    });
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dy = e.ctrlKey ? Math.max(-80, Math.min(80, e.deltaY)) : Math.max(-140, Math.min(140, e.deltaY));
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0022));
      lbSetScaleAt(localLbState.scale * factor, e.clientX, e.clientY, true);
    }, { passive: false });
    img.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (localLbState.scale > 1.05) {
        localLbState.scale = 1; localLbState.tx = 0; localLbState.ty = 0; lbApplyTransform(false);
      } else {
        lbSetScaleAt(2.5, e.clientX, e.clientY, false);
      }
    });
    img.addEventListener("mousedown", (e) => {
      if (localLbState.scale <= 1.01) return;
      e.preventDefault();
      localLbState.dragging = true;
      localLbState.justDragged = false;
      localLbState.dragStartX = e.clientX;
      localLbState.dragStartY = e.clientY;
      localLbState.originTx = localLbState.tx;
      localLbState.originTy = localLbState.ty;
      img.classList.add("dragging");
    });
    document.addEventListener("mousemove", (e) => {
      if (!localLbState.dragging || !localLbState.open) return;
      const dx = e.clientX - localLbState.dragStartX;
      const dy = e.clientY - localLbState.dragStartY;
      if (Math.hypot(dx, dy) > 4) localLbState.justDragged = true;
      const cl = lbClampPan(
        localLbState.originTx + dx,
        localLbState.originTy + dy,
        localLbState.scale,
      );
      localLbState.tx = cl.tx;
      localLbState.ty = cl.ty;
      lbApplyTransform(true);
    });
    document.addEventListener("mouseup", () => {
      if (!localLbState.dragging) return;
      localLbState.dragging = false;
      if (localLbDom) localLbDom.img.classList.remove("dragging");
      if (localLbState.justDragged) {
        setTimeout(() => { localLbState.justDragged = false; }, 0);
      }
    });

    root.append(topbar, stage, prevBtn, nextBtn, dock);
    document.body.appendChild(root);
    localLbDom = { root, counter, meta, closeBtn, stage, img, prevBtn, nextBtn, strip, toolbar, pctBtn, oneBtn };
    return localLbDom;
  }

  function openLocalImageLightbox(src, triggerEl) {
    if (!isSafeLocalImageUrl(src)) return false;
    const dom = ensureLocalLightboxDom();
    const items = [];
    let activeIdx = -1;
    const nodes = elMessages ? elMessages.querySelectorAll("img.wx-inline-img") : [];
    nodes.forEach((node) => {
      const s = (node.getAttribute("src") || "").trim();
      if (!isSafeLocalImageUrl(s)) return;
      if (triggerEl && node === triggerEl) activeIdx = items.length;
      items.push({ src: s, alt: (node.getAttribute("alt") || "").trim() });
    });
    if (activeIdx < 0) {
      activeIdx = items.findIndex((it) => it.src === src.trim());
    }
    if (activeIdx < 0) {
      items.push({ src: src.trim(), alt: "" });
      activeIdx = items.length - 1;
    }
    localLbState.prevFocus = document.activeElement;
    localLbState.items = items;
    localLbState.index = activeIdx;
    localLbState.open = true;
    localLbState.justDragged = false;
    localLbState.stageDownTarget = null;
    lbUpdateView();
    dom.root.classList.add("open");
    if (dom.closeBtn && typeof dom.closeBtn.focus === "function") {
      try { dom.closeBtn.focus({ preventScroll: true }); } catch { try { dom.closeBtn.focus(); } catch {} }
    }
    return true;
  }

  function appendInlineRichText(parent, text) {
    const tokenRe =
      /!\[([^\]\n]{0,120})\]\(([^)\s\n]+)\)|\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s\n]+)\)|(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(~~[^~\n]+?~~)|(https?:\/\/[^\s<>"'`]+)|((?:^|(?<=[\s(\[，。、]))@[a-zA-Z0-9][a-zA-Z0-9._-]{1,62})/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      if (m[2] !== undefined) {
        const imgUrl = m[2].trim();
        if (isSafeLocalImageUrl(imgUrl)) {
          const wrap = document.createElement("span");
          wrap.className = "wx-inline-img-wrap";
          const img = document.createElement("img");
          img.className = "wx-inline-img";
          img.src = imgUrl;
          img.alt = (m[1] || "image").trim();
          img.loading = "lazy";
          img.title = img.alt && img.alt !== "image" ? `${img.alt}（点击放大查看）` : "点击放大查看";
          img.addEventListener("click", () => openLocalImageLightbox(imgUrl, img));
          wrap.appendChild(img);
          parent.appendChild(wrap);
        } else {
          parent.appendChild(document.createTextNode(m[0]));
        }
      } else if (m[4] !== undefined) {
        const a = document.createElement("a");
        a.className = "msg-link";
        a.href = m[4];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = m[4];
        a.textContent = m[3];
        parent.appendChild(a);
      } else if (m[5]) {
        const code = document.createElement("code");
        code.className = "inline-code";
        code.textContent = m[5].slice(1, -1);
        parent.appendChild(code);
      } else if (m[6]) {
        const strong = document.createElement("strong");
        strong.textContent = m[6].slice(2, -2);
        parent.appendChild(strong);
      } else if (m[7]) {
        const em = document.createElement("em");
        em.textContent = m[7].slice(1, -1);
        parent.appendChild(em);
      } else if (m[8]) {
        const del = document.createElement("del");
        del.className = "wx-md-del";
        del.textContent = m[8].slice(2, -2);
        parent.appendChild(del);
      } else if (m[9]) {
        const a = document.createElement("a");
        a.className = "msg-link";
        a.href = m[9];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = m[9];
        parent.appendChild(a);
      } else if (m[10]) {
        const handle = m[10];
        const chip = document.createElement("span");
        chip.className = "mention-chip clickable" + (isMentionMe(handle) ? " mention-me" : "");
        chip.textContent = handle;
        chip.title = `点击插入 ${handle}`;
        chip.addEventListener("click", () => {
          insertTextAtCursor(elInput, `${handle} `);
          saveLocalDraft(currentChannelId, elInput.value);
          syncComposerState();
        });
        parent.appendChild(chip);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function parseTableCells(line) {
    let trimmed = String(line || "").trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map((c) => c.trim());
  }

  function parseTableAlignments(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed.includes("|") || !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) {
      return null;
    }
    return parseTableCells(trimmed).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return "left";
    });
  }

  function appendRichBlocks(container, rawSegment, trimEdges) {
    const seg = trimEdges ? String(rawSegment || "").replace(/^\n+|\n+$/g, "") : String(rawSegment || "");
    if (!seg) return;
    const lines = seg.split("\n");
    let proseBuf = [];

    const flushProse = (trimTrailing) => {
      if (!proseBuf.length) return;
      let joined = proseBuf.join("\n");
      proseBuf = [];
      if (trimTrailing) joined = joined.replace(/\n+$/, "");
      if (!joined) return;
      const span = document.createElement("span");
      appendInlineRichText(span, joined);
      container.appendChild(span);
    };

    let i = 0;
    while (i < lines.length) {
      const aligns =
        lines[i].includes("|") && i + 1 < lines.length ? parseTableAlignments(lines[i + 1]) : null;
      if (aligns && aligns.length >= 2) {
        flushProse(true);
        const headerCells = parseTableCells(lines[i]);
        const colCount = Math.max(headerCells.length, aligns.length);
        const wrap = document.createElement("div");
        wrap.className = "ac-table-wrap";
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const headTr = document.createElement("tr");
        for (let c = 0; c < colCount; c++) {
          const th = document.createElement("th");
          if (aligns[c] && aligns[c] !== "left") th.style.textAlign = aligns[c];
          appendInlineRichText(th, headerCells[c] || "");
          headTr.appendChild(th);
        }
        thead.appendChild(headTr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const rowCells = parseTableCells(lines[i]);
          const tr = document.createElement("tr");
          for (let c = 0; c < colCount; c++) {
            const td = document.createElement("td");
            if (aligns[c] && aligns[c] !== "left") td.style.textAlign = aligns[c];
            appendInlineRichText(td, rowCells[c] || "");
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i += 1;
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        container.appendChild(wrap);
        while (i < lines.length && !lines[i].trim()) i += 1;
        continue;
      }
      const trimmedLine = lines[i].trim();
      const headingMatch = trimmedLine.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        flushProse(true);
        const hEl = document.createElement("div");
        hEl.className = `wx-md-heading h${headingMatch[1].length}`;
        appendInlineRichText(hEl, headingMatch[2]);
        container.appendChild(hEl);
        i += 1;
        continue;
      }
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmedLine)) {
        flushProse(true);
        const hr = document.createElement("hr");
        hr.className = "wx-md-hr";
        container.appendChild(hr);
        i += 1;
        continue;
      }
      if (/^>\s?/.test(trimmedLine)) {
        flushProse(true);
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        const bq = document.createElement("blockquote");
        bq.className = "wx-md-quote";
        appendInlineRichText(bq, quoteLines.join("\n"));
        container.appendChild(bq);
        continue;
      }
      if (/^[-*+]\s+/.test(trimmedLine)) {
        flushProse(true);
        const ul = document.createElement("ul");
        ul.className = "wx-md-list";
        let hasChecklist = false;
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^[-*+]\s+/, "");
          const li = document.createElement("li");
          const chk = itemText.match(/^\[(x|X| )\]\s+(.+)$/);
          if (chk) {
            hasChecklist = true;
            const checked = chk[1].toLowerCase() === "x";
            li.className = "wx-md-check-item" + (checked ? " done" : "");
            const box = document.createElement("span");
            box.className = "wx-md-check-box" + (checked ? " done" : "");
            box.setAttribute("aria-hidden", "true");
            box.textContent = checked ? "✓" : "";
            const bodySpan = document.createElement("span");
            appendInlineRichText(bodySpan, chk[2]);
            li.append(box, bodySpan);
          } else {
            appendInlineRichText(li, itemText);
          }
          ul.appendChild(li);
          i += 1;
        }
        if (hasChecklist) ul.classList.add("wx-md-checklist");
        container.appendChild(ul);
        continue;
      }
      if (/^\d+\.\s+/.test(trimmedLine)) {
        flushProse(true);
        const ol = document.createElement("ol");
        ol.className = "wx-md-list wx-md-ol";
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
          const li = document.createElement("li");
          appendInlineRichText(li, itemText);
          ol.appendChild(li);
          i += 1;
        }
        container.appendChild(ol);
        continue;
      }
      proseBuf.push(lines[i]);
      i += 1;
    }
    flushProse(false);
  }

  function renderFormattedBody(container, rawText) {
    const text = String(rawText || "");
    const fenceRe = /```([a-zA-Z0-9_#+-]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let match;
    let hasBlocks = false;
    while ((match = fenceRe.exec(text)) !== null) {
      hasBlocks = true;
      if (match.index > last) {
        appendRichBlocks(container, text.slice(last, match.index), true);
      }
      const lang = (match[1] || "code").toUpperCase();
      const codeText = match[2].replace(/\n$/, "");
      const wrap = document.createElement("div");
      wrap.className = "code-block-wrap";
      const head = document.createElement("div");
      head.className = "code-block-head";
      const langEl = document.createElement("span");
      langEl.className = "code-block-lang";
      langEl.textContent = lang;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "icon-btn";
      copyBtn.appendChild(createSvgIcon("copy"));
      const copyLbl = document.createElement("span");
      copyLbl.textContent = "复制";
      copyBtn.appendChild(copyLbl);
      copyBtn.addEventListener("click", async () => {
        await copyTextToClipboard(codeText);
        copyLbl.textContent = "✓ 已复制";
        copyBtn.classList.add("copied");
        clearTimeout(copyBtn._copyTimer);
        copyBtn._copyTimer = setTimeout(() => {
          copyLbl.textContent = "复制";
          copyBtn.classList.remove("copied");
        }, 1500);
        showToast("已复制代码块");
      });
      head.appendChild(langEl);
      head.appendChild(copyBtn);
      const pre = document.createElement("pre");
      pre.className = "code-block-pre";
      const codeEl = document.createElement("code");
      appendSyntaxHighlightedCode(codeEl, codeText);
      pre.appendChild(codeEl);
      wrap.appendChild(head);
      wrap.appendChild(pre);
      container.appendChild(wrap);
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      appendRichBlocks(container, text.slice(last), hasBlocks);
    }
  }

  function highlightSearchHits(container, rawQuery) {
    const query = String(rawQuery || "").trim();
    if (!query || !container) return;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) {
      if (current.parentElement && current.parentElement.closest(".code-block-head")) continue;
      if (re.test(current.nodeValue || "")) nodes.push(current);
      re.lastIndex = 0;
    }
    for (const node of nodes) {
      const value = node.nodeValue || "";
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = re.exec(value)) !== null) {
        if (match.index > last) {
          frag.appendChild(document.createTextNode(value.slice(last, match.index)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = match[0];
        frag.appendChild(mark);
        last = match.index + match[0].length;
        if (match[0].length === 0) break;
      }
      if (last < value.length) {
        frag.appendChild(document.createTextNode(value.slice(last)));
      }
      node.parentNode?.replaceChild(frag, node);
    }
  }

  function formatWeChatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatFullLocalTimestamp(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function shouldShowTimeDivider(prev, curr) {
    if (!curr?.timestamp) return false;
    if (!prev?.timestamp) return true;
    const t1 = Date.parse(prev.timestamp);
    const t2 = Date.parse(curr.timestamp);
    if (Number.isNaN(t1) || Number.isNaN(t2)) return false;
    return Math.abs(t2 - t1) >= 5 * 60 * 1000;
  }

  async function editLocalMessage(m) {
    if (!m || !m.id || m.sender_id !== currentPrincipal?.id) return;
    const r = await openPromptDialog({
      title: "✏️ 编辑消息",
      hint: "支持多行 Markdown 与代码块，⌘/Ctrl + Enter 快捷保存并实时同步给所有成员。",
      placeholder1: "输入新的消息内容",
      value1: m.content || "",
      multiline: true,
    });
    if (!r?.v1 || r.v1 === m.content) return;
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
  }

  async function deleteLocalMessage(m) {
    if (!m || !m.id || m.sender_id !== currentPrincipal?.id) return;
    const rawPreview = String(m.content || "").replace(/\s+/g, " ").trim();
    const snippet = rawPreview.length > 56 ? rawPreview.slice(0, 55) + "…" : rawPreview;
    const confirmed = await openConfirmDialog({
      title: "撤回这条消息？",
      hint: snippet
        ? `“${snippet}” 将从当前本地房间移除，此操作无法撤销。`
        : "此消息将从当前本地房间移除，此操作无法撤销。",
      confirmText: "确认撤回",
      cancelText: "保留消息",
      danger: true,
    });
    if (!confirmed) return;
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
  }

  function openMessageContextMenu(m, isSelf, clientX, clientY) {
    closeChannelContextMenu(false);
    if (!m) return;
    const menu = document.createElement("div");
    menu.id = "local-ctx-menu";
    menu.className = "local-ctx-menu";
    menu.setAttribute("role", "menu");

    const addItem = (label, onClick, isDanger = false) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "local-ctx-item" + (isDanger ? " danger" : "");
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeChannelContextMenu(false);
        onClick();
      });
      menu.appendChild(item);
    };

    addItem("↩ 引用回复", () => setReplyTarget(m));
    addItem("📋 复制消息", async () => {
      await copyTextToClipboard(String(m.content || ""));
      showToast("已复制消息");
    });

    if (isSelf && m.id) {
      const sep = document.createElement("div");
      sep.className = "local-ctx-sep";
      menu.appendChild(sep);
      addItem("✏️ 编辑消息", () => { void editLocalMessage(m); });
      addItem("🗑️ 撤回消息", () => { void deleteLocalMessage(m); }, true);
    }

    mountContextMenu(menu, clientX, clientY);
  }

  elMessages?.addEventListener("contextmenu", (ev) => {
    const bubble = ev.target?.closest?.(".wx-bubble");
    if (!bubble) return;
    const selText = window.getSelection ? String(window.getSelection().toString() || "").trim() : "";
    if (selText) return;
    const row = bubble.closest(".wx-msg");
    const msgId = row?.dataset?.msgId;
    if (!msgId) return;
    const found = messages.find((item) => item && item.id === msgId);
    if (!found) return;
    ev.preventDefault();
    const isSelf = found.sender_id === currentPrincipal?.id;
    openMessageContextMenu(found, isSelf, ev.clientX, ev.clientY);
  });

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
      btnMore.addEventListener("click", () => void loadOlderMessages(btnMore));
      loadMoreWrap.appendChild(btnMore);
      elMessages.appendChild(loadMoreWrap);
    }

    const msgById = new Map(messages.map((m) => [m.id, m]));
    const showUnreadDivider =
      pendingUnreadBanner &&
      pendingUnreadBanner.channelId === currentChannelId &&
      pendingUnreadBanner.count > 0 &&
      !activeSearchQuery &&
      messages.length > 0;
    const unreadDividerIdx = showUnreadDivider
      ? Math.max(0, messages.length - pendingUnreadBanner.count)
      : -1;
    let unreadDividerEl = null;

    messages.forEach((m, idx) => {
      if (showUnreadDivider && idx === unreadDividerIdx) {
        const udiv = document.createElement("div");
        udiv.id = "localUnreadDivider";
        udiv.className = "unread-divider";
        const uSpan = document.createElement("span");
        uSpan.textContent = `以下为 ${pendingUnreadBanner.count} 条新消息`;
        udiv.appendChild(uSpan);
        elMessages.appendChild(udiv);
        unreadDividerEl = udiv;
      }
      if (shouldShowTimeDivider(messages[idx - 1], m)) {
        const divider = document.createElement("div");
        divider.className = "time-divider";
        divider.textContent = formatWeChatTime(m.timestamp);
        elMessages.appendChild(divider);
      }

      const isSelf = m.sender_id === currentPrincipal?.id;
      const row = document.createElement("div");
      row.className = "wx-msg" + (isSelf ? " self" : "");
      if (m.id) row.dataset.msgId = m.id;

      const av = document.createElement("div");
      av.className = "wx-avatar" + (isSelf ? "" : " clickable");
      av.style.background = isSelf ? "#07c160" : avatarBg(m.sender_id);
      av.textContent = avatarInitials(m.sender_name, m.sender_id);
      if (!isSelf) {
        av.title = `点击插入 @${m.sender_id}`;
        av.setAttribute("role", "button");
        av.tabIndex = 0;
        av.setAttribute("aria-label", `提及 @${m.sender_id}`);
        const mentionFromAvatar = () => {
          insertTextAtCursor(elInput, `@${m.sender_id} `);
          saveLocalDraft(currentChannelId, elInput.value);
          syncComposerState();
        };
        av.addEventListener("click", mentionFromAvatar);
        av.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            mentionFromAvatar();
          }
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
        idSpan.className = "wx-sender-id clickable";
        idSpan.textContent = `@${m.sender_id}`;
        idSpan.title = `点击复制 @${m.sender_id}`;
        idSpan.setAttribute("role", "button");
        idSpan.tabIndex = 0;
        idSpan.setAttribute("aria-label", `复制 @${m.sender_id}`);
        const copySenderHandle = async () => {
          await copyTextToClipboard(`@${m.sender_id}`);
          showToast(`已复制 @${m.sender_id}`);
        };
        idSpan.addEventListener("click", () => { void copySenderHandle(); });
        idSpan.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            void copySenderHandle();
          }
        });
        sender.appendChild(nameSpan);
        sender.appendChild(idSpan);
        const shortTs = formatWeChatTime(m.timestamp);
        if (shortTs) {
          const tsSpan = document.createElement("span");
          tsSpan.className = "wx-sender-time";
          tsSpan.textContent = shortTs;
          const fullTs = formatFullLocalTimestamp(m.timestamp);
          if (fullTs) tsSpan.title = fullTs;
          sender.appendChild(tsSpan);
        }
        col.appendChild(sender);
      }

      const bubbleRow = document.createElement("div");
      bubbleRow.className = "wx-bubble-row";

      const bubble = document.createElement("div");
      bubble.className = "wx-bubble";
      const fullBubbleTs = formatFullLocalTimestamp(m.timestamp);
      if (fullBubbleTs) bubble.title = fullBubbleTs;
      renderFormattedBody(bubble, m.content);
      if (activeSearchQuery) highlightSearchHits(bubble, activeSearchQuery);
      bubbleRow.appendChild(bubble);

      const actions = document.createElement("div");
      actions.className = "wx-actions";

      const btnQuote = document.createElement("button");
      btnQuote.type = "button";
      btnQuote.className = "wx-act-btn";
      btnQuote.title = "引用回复";
      btnQuote.setAttribute("aria-label", "引用回复");
      btnQuote.appendChild(createSvgIcon("reply"));
      btnQuote.addEventListener("click", () => setReplyTarget(m));
      actions.appendChild(btnQuote);

      const btnCopyMsg = document.createElement("button");
      btnCopyMsg.type = "button";
      btnCopyMsg.className = "wx-act-btn";
      btnCopyMsg.title = "复制消息内容";
      btnCopyMsg.setAttribute("aria-label", "复制消息内容");
      btnCopyMsg.appendChild(createSvgIcon("copy"));
      btnCopyMsg.addEventListener("click", async () => {
        await copyTextToClipboard(String(m.content || ""));
        showToast("已复制消息");
      });
      actions.appendChild(btnCopyMsg);

      if (isSelf) {
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "wx-act-btn";
        btnEdit.title = "编辑消息";
        btnEdit.setAttribute("aria-label", "编辑消息");
        btnEdit.appendChild(createSvgIcon("edit"));
        btnEdit.addEventListener("click", () => { void editLocalMessage(m); });

        const btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "wx-act-btn danger";
        btnDel.title = "撤回消息";
        btnDel.setAttribute("aria-label", "撤回消息");
        btnDel.appendChild(createSvgIcon("trash"));
        btnDel.addEventListener("click", () => { void deleteLocalMessage(m); });

        actions.appendChild(btnEdit);
        actions.appendChild(btnDel);
      }

      bubbleRow.appendChild(actions);
      col.appendChild(bubbleRow);

      if (m.in_reply_to) {
        const quoted = msgById.get(m.in_reply_to);
        const quoteEl = document.createElement("div");
        quoteEl.className = "wx-quote-pill" + (quoted ? " jumpable" : "");
        quoteEl.textContent = quoted
          ? `${quoted.sender_name || quoted.sender_id}: ${(quoted.content || "").slice(0, 80)}`
          : `引用消息 #${String(m.in_reply_to).slice(0, 8)}`;
        if (quoted) {
          quoteEl.title = "点击定位到原消息";
          quoteEl.setAttribute("role", "button");
          quoteEl.tabIndex = 0;
          quoteEl.setAttribute("aria-label", `定位到被引用消息：${quoted.sender_name || quoted.sender_id}`);
          const jumpToQuoted = () => {
            const targetRow = Array.from(elMessages.querySelectorAll(".wx-msg")).find(
              (el) => el.dataset.msgId === quoted.id,
            );
            if (!targetRow) return;
            targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
            targetRow.classList.remove("wx-jump-flash");
            void targetRow.offsetWidth;
            targetRow.classList.add("wx-jump-flash");
            setTimeout(() => targetRow.classList.remove("wx-jump-flash"), 1200);
          };
          quoteEl.addEventListener("click", jumpToQuoted);
          quoteEl.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              jumpToQuoted();
            }
          });
        }
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
    } else if (unreadDividerEl && pendingUnreadBanner && pendingUnreadBanner.count > 2) {
      pendingNewInRoom = 0;
      elMessages.scrollTop = Math.max(0, unreadDividerEl.offsetTop - 24);
    } else {
      pendingNewInRoom = 0;
      elMessages.scrollTop = elMessages.scrollHeight;
    }
    updateScrollPill();
    syncSearchMatches();
  }

  async function sendChatText(rawText) {
    if (isSendingChat) return;
    const text = String(rawText ?? elInput.value).trim();
    if (!text) return;
    if (!authToken) {
      showToast("请先同步或填入全局账号凭证");
      return;
    }
    const targetChannel = currentChannelId;
    const savedReply = replyTarget ? { ...replyTarget } : null;
    isSendingChat = true;
    pendingUnreadBanner = null;
    elInput.value = "";
    clearLocalDraft(targetChannel);
    setReplyTarget(null);
    syncComposerState();
    const payload = { content: text };
    if (savedReply?.id) payload.in_reply_to = savedReply.id;

    const restoreFailedDraft = () => {
      saveLocalDraft(targetChannel, text);
      if (currentChannelId === targetChannel && elInput && !String(elInput.value || "").trim()) {
        elInput.value = text;
        if (savedReply && !replyTarget) setReplyTarget(savedReply);
        elInput.focus();
      }
    };

    try {
      const res = await api(`/api/channels/${encodeURIComponent(targetChannel)}/messages`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        restoreFailedDraft();
        showToast(res.data?.error || "发送失败，已保留原消息内容");
        return;
      }
      if (
        currentChannelId === targetChannel &&
        res.data?.message &&
        !messages.some((m) => m.id === res.data.message.id)
      ) {
        messages.push(res.data.message);
        renderMessages();
      }
    } catch {
      restoreFailedDraft();
      showToast("发送失败，请重试（原消息已保留）");
    } finally {
      isSendingChat = false;
      syncComposerState();
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
    insertTextAtCursor(elInput, "@");
    saveLocalDraft(currentChannelId, elInput.value);
    updateMentionMenu();
  });
  document.getElementById("btn-quick-connect")?.addEventListener("click", () => {
    document.getElementById("btn-copy-mcp")?.click();
  });
  document.getElementById("btn-quick-export")?.addEventListener("click", () => {
    document.getElementById("btn-export-md")?.click();
  });

  // Pure-DOM Cmd/Ctrl+K Quick Channel Switcher & Command Palette
  let switcherBg = null;
  let switcherInput = null;
  let switcherList = null;
  let switcherItems = [];
  let switcherIdx = 0;
  let switcherPrevFocus = null;

  function buildLocalSwitcherEntries(query) {
    const q = (query || "").trim().toLowerCase();
    const entries = [];
    const chEntries = [];
    for (const ch of channels) {
      if (!ch || !ch.id) continue;
      const isDm = ch.channel_type === "direct" || ch.id.startsWith("dm-");
      const label = ch.name || ch.id;
      const unread = unreadByChannel.get(ch.id) || 0;
      const pinned = isChannelPinned(ch.id);
      const hasDraft = Boolean(getLocalDraft(ch.id));
      const haystack = `${label} ${ch.id} ${ch.topic || ""}`.toLowerCase();
      if (q && !haystack.includes(q)) continue;
      chEntries.push({
        section: "本地房间与私聊",
        icon: pinned ? "📌" : isDm ? "👤" : "#",
        label,
        meta: hasDraft ? "[草稿]" : ch.id === currentChannelId ? "当前" : pinned ? "置顶" : "",
        isDraft: hasDraft,
        unread,
        score: (pinned ? 8 : 0) + (unread > 0 ? 4 : 0) + (hasDraft ? 2 : 0) + (ch.id === currentChannelId ? 1 : 0),
        run: () => {
          void selectChannel(ch.id);
        },
      });
    }
    chEntries.sort((a, b) => b.score - a.score);
    entries.push(...chEntries);

    const actions = [
      {
        icon: "🔍",
        label: "搜索当前房间消息",
        meta: isMacPlatform() ? "⌘F" : "Ctrl+F",
        kw: "search find 搜索",
        run: () => {
          elSearchInput?.focus();
          elSearchInput?.select();
        },
      },
      {
        icon: "＋",
        label: "新建本地群聊",
        meta: "",
        kw: "new group create channel 新建 群聊",
        run: () => document.getElementById("btn-new-group")?.click(),
      },
      {
        icon: "💬",
        label: "发起 1v1 私聊",
        meta: "",
        kw: "dm direct message 私聊",
        run: () => document.getElementById("btn-new-dm")?.click(),
      },
      {
        icon: "👥",
        label: "拉入成员到当前房间",
        meta: "",
        kw: "invite member agent 拉人 成员",
        run: () => document.getElementById("btn-invite-member")?.click(),
      },
      {
        icon: "🔌",
        label: "查看 MCP 接入配置 / LAN 局域网",
        meta: "",
        kw: "mcp lan connect setup 接入",
        run: () => document.getElementById("btn-copy-mcp")?.click(),
      },
      {
        icon: "☁️",
        label: "切换到 AgentsChat Cloud（云端母机 / OKR）",
        meta: "",
        kw: "cloud okr loop 云端",
        run: () => document.getElementById("btn-go-cloud")?.click(),
      },
      {
        icon: "🏪",
        label: "打开 Bot 租赁市场",
        meta: "",
        kw: "marketplace rental bot 租赁 广场",
        run: () => document.getElementById("btn-go-marketplace")?.click(),
      },
      {
        icon: "✅",
        label: "全部本机未读标为已读",
        meta: unreadByChannel.size > 0 ? `${Array.from(unreadByChannel.values()).reduce((a, b) => a + b, 0)} 条` : "",
        kw: "read unread clear mark all 已读 未读 清除",
        run: () => markAllLocalChannelsRead(),
      },
      {
        icon: "📄",
        label: "导出当前对话为 Markdown",
        meta: "",
        kw: "export markdown md 导出",
        run: () => document.getElementById("btn-export-md")?.click(),
      },
      {
        icon: "🌓",
        label: "切换浅色 / 深色模式",
        meta: "",
        kw: "theme dark light 主题 深色 浅色",
        run: () => document.getElementById("btn-toggle-theme")?.click(),
      },
      {
        icon: "⌨️",
        label: "快捷键一览",
        meta: "?",
        kw: "shortcut keyboard help cheatsheet 快捷键 帮助",
        run: () => openLocalShortcutsCheatsheet(),
      },
    ];
    for (const act of actions) {
      if (q && !(act.label.toLowerCase().includes(q) || act.kw.includes(q))) continue;
      entries.push({
        section: "快捷操作",
        icon: act.icon,
        label: act.label,
        meta: act.meta,
        isDraft: false,
        unread: 0,
        run: act.run,
      });
    }
    return entries;
  }

  function syncLocalSwitcherActive(scrollIntoView = false) {
    if (!switcherList) return;
    const nodes = Array.from(switcherList.querySelectorAll(".local-switcher-item"));
    let activeNode = null;
    nodes.forEach((n, i) => {
      const isAct = i === switcherIdx;
      n.classList.toggle("active", isAct);
      n.setAttribute("aria-selected", String(isAct));
      if (isAct) activeNode = n;
    });
    if (switcherInput) {
      if (activeNode && activeNode.id) switcherInput.setAttribute("aria-activedescendant", activeNode.id);
      else switcherInput.removeAttribute("aria-activedescendant");
    }
    if (scrollIntoView && activeNode && typeof activeNode.scrollIntoView === "function") {
      try { activeNode.scrollIntoView({ block: "nearest" }); } catch {}
    }
  }

  function renderLocalSwitcherList() {
    if (!switcherList) return;
    switcherItems = buildLocalSwitcherEntries(switcherInput ? switcherInput.value : "");
    if (switcherIdx >= switcherItems.length) switcherIdx = Math.max(0, switcherItems.length - 1);
    switcherList.replaceChildren();
    if (switcherItems.length === 0) {
      if (switcherInput) switcherInput.removeAttribute("aria-activedescendant");
      const empty = document.createElement("div");
      empty.className = "local-switcher-empty";
      empty.setAttribute("role", "status");
      empty.textContent = "没有匹配的本地房间或快捷指令";
      switcherList.appendChild(empty);
      return;
    }
    let lastSec = "";
    switcherItems.forEach((item, idx) => {
      if (item.section !== lastSec) {
        lastSec = item.section;
        const sec = document.createElement("div");
        sec.className = "local-switcher-sec";
        sec.setAttribute("role", "presentation");
        sec.textContent = lastSec;
        switcherList.appendChild(sec);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = `local-switcher-opt-${idx}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(idx === switcherIdx));
      btn.className = "local-switcher-item" + (idx === switcherIdx ? " active" : "");
      const ic = document.createElement("span");
      ic.className = "local-switcher-icon";
      ic.setAttribute("aria-hidden", "true");
      ic.textContent = item.icon;
      const lbl = document.createElement("span");
      lbl.className = "local-switcher-label";
      lbl.textContent = item.label;
      btn.appendChild(ic);
      btn.appendChild(lbl);
      if (item.meta) {
        const meta = document.createElement("span");
        meta.className = item.isDraft ? "local-switcher-draft" : "local-switcher-meta";
        meta.textContent = item.meta;
        btn.appendChild(meta);
      }
      if (item.unread > 0) {
        const badge = document.createElement("span");
        badge.className = "local-switcher-unread";
        badge.textContent = item.unread > 99 ? "99+" : String(item.unread);
        btn.appendChild(badge);
      }
      btn.addEventListener("mouseenter", () => {
        if (switcherIdx !== idx) {
          switcherIdx = idx;
          syncLocalSwitcherActive(false);
        }
      });
      btn.addEventListener("click", () => {
        closeLocalSwitcher();
        item.run();
      });
      switcherList.appendChild(btn);
    });
    syncLocalSwitcherActive(true);
  }

  function ensureLocalSwitcher() {
    if (switcherBg) return;
    switcherBg = document.createElement("div");
    switcherBg.className = "local-switcher-bg";
    switcherBg.id = "local-switcher-modal";
    switcherBg.hidden = true;

    const panel = document.createElement("div");
    panel.className = "local-switcher";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "快速跳转与指令面板");

    const head = document.createElement("div");
    head.className = "local-switcher-head";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "local-switcher-search-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "11");
    c.setAttribute("cy", "11");
    c.setAttribute("r", "7");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", "m20 20-3.5-3.5");
    svg.appendChild(c);
    svg.appendChild(p);

    switcherInput = document.createElement("input");
    switcherInput.type = "search";
    switcherInput.className = "local-switcher-input";
    switcherInput.placeholder = "快速跳转本地房间、私聊或执行快捷指令…";
    switcherInput.autocomplete = "off";
    switcherInput.setAttribute("role", "combobox");
    switcherInput.setAttribute("aria-autocomplete", "list");
    switcherInput.setAttribute("aria-controls", "local-switcher-list");
    switcherInput.setAttribute("aria-expanded", "false");
    switcherInput.setAttribute("aria-label", "搜索本地房间或快捷指令");

    const escPill = document.createElement("span");
    escPill.className = "local-switcher-esc";
    escPill.textContent = "ESC";

    head.appendChild(svg);
    head.appendChild(switcherInput);
    head.appendChild(escPill);

    switcherList = document.createElement("div");
    switcherList.id = "local-switcher-list";
    switcherList.className = "local-switcher-list";
    switcherList.setAttribute("role", "listbox");
    switcherList.setAttribute("aria-label", "房间与快捷指令");

    const foot = document.createElement("div");
    foot.className = "local-switcher-foot";
    const switcherMod = isMacPlatform() ? "⌘" : "Ctrl+";
    const switcherAlt = isMacPlatform() ? "⌥" : "Alt+";
    for (const tip of ["↑↓ / Home / End 选择", "↵ 执行", `${switcherAlt}↑↓ 切换频道`, `${switcherMod}F 搜消息`]) {
      const sp = document.createElement("span");
      sp.textContent = tip;
      foot.appendChild(sp);
    }

    panel.appendChild(head);
    panel.appendChild(switcherList);
    panel.appendChild(foot);
    switcherBg.appendChild(panel);
    document.body.appendChild(switcherBg);

    switcherBg.addEventListener("click", (ev) => {
      const downTarget = _localDialogDownTarget;
      _localDialogDownTarget = null;
      if (ev.target === switcherBg && (!downTarget || downTarget === switcherBg)) closeLocalSwitcher();
    });
    switcherInput.addEventListener("input", () => {
      switcherIdx = 0;
      renderLocalSwitcherList();
    });
    switcherInput.addEventListener("keydown", (ev) => {
      if (isImeComposing(ev)) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (switcherItems.length) {
          switcherIdx = (switcherIdx + 1) % switcherItems.length;
          syncLocalSwitcherActive(true);
        }
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (switcherItems.length) {
          switcherIdx = (switcherIdx - 1 + switcherItems.length) % switcherItems.length;
          syncLocalSwitcherActive(true);
        }
      } else if (ev.key === "Home") {
        if (switcherItems.length) {
          ev.preventDefault();
          switcherIdx = 0;
          syncLocalSwitcherActive(true);
        }
      } else if (ev.key === "End") {
        if (switcherItems.length) {
          ev.preventDefault();
          switcherIdx = switcherItems.length - 1;
          syncLocalSwitcherActive(true);
        }
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const chosen = switcherItems[switcherIdx];
        if (chosen) {
          closeLocalSwitcher();
          chosen.run();
        }
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeLocalSwitcher();
      }
    });
  }

  function openLocalSwitcher() {
    ensureLocalSwitcher();
    switcherPrevFocus = document.activeElement;
    switcherInput.value = "";
    switcherIdx = 0;
    switcherBg.hidden = false;
    switcherInput.setAttribute("aria-expanded", "true");
    renderLocalSwitcherList();
    switcherInput.focus();
  }

  function closeLocalSwitcher() {
    if (!switcherBg || switcherBg.hidden) return;
    switcherBg.hidden = true;
    if (switcherInput) {
      switcherInput.setAttribute("aria-expanded", "false");
      switcherInput.removeAttribute("aria-activedescendant");
    }
    if (switcherPrevFocus && typeof switcherPrevFocus.focus === "function") {
      try {
        switcherPrevFocus.focus();
      } catch {}
    }
  }

  let kbdBg = null;
  let kbdPrevFocus = null;

  function closeLocalShortcutsCheatsheet() {
    if (!kbdBg || kbdBg.hidden) return;
    kbdBg.hidden = true;
    if (kbdPrevFocus && typeof kbdPrevFocus.focus === "function") {
      try {
        kbdPrevFocus.focus();
      } catch {}
    }
  }

  function isMacPlatform() {
    if (bridge?.platform) return bridge.platform === "darwin";
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
  }

  function applyLocalPlatformShortcuts() {
    const isMac = isMacPlatform();
    const mod = isMac ? "⌘" : "Ctrl+";
    const modShift = isMac ? "⌘⇧" : "Ctrl+Shift+";
    if (elSearchInput) elSearchInput.placeholder = `搜索本房间消息 (${mod}F)`;
    const btnQs = document.getElementById("btn-quick-switcher");
    if (btnQs) {
      btnQs.textContent = isMac ? "⌘K" : "Ctrl+K";
      btnQs.title = `快速跳转房间与指令面板 (${mod}K)`;
      btnQs.setAttribute("aria-label", `快速切换与指令面板 (${mod}K)`);
    }
    const hint = document.querySelector(".composer-hint");
    if (hint) hint.textContent = `Enter 发送 · Shift+Enter 换行 · ${mod}/ 聚焦`;
    const btnPrev = document.getElementById("btn-search-prev");
    const btnNext = document.getElementById("btn-search-next");
    if (btnPrev) btnPrev.title = `上一处匹配 (Shift+Enter / ${modShift}G)`;
    if (btnNext) btnNext.title = `下一处匹配 (Enter / ${mod}G)`;
  }

  function openLocalShortcutsCheatsheet() {
    closeLocalSwitcher();
    closeChannelContextMenu();
    kbdPrevFocus = document.activeElement;
    const isMac = isMacPlatform();
    const mod = isMac ? "⌘" : "Ctrl";
    const alt = isMac ? "⌥" : "Alt";
    const shift = isMac ? "⇧" : "Shift";
    if (!kbdBg) {
      kbdBg = document.createElement("div");
      kbdBg.id = "localKbdCheatsheet";
      kbdBg.className = "local-kbd-bg";
      kbdBg.hidden = true;
      kbdBg.setAttribute("role", "dialog");
      kbdBg.setAttribute("aria-modal", "true");
      kbdBg.setAttribute("aria-label", "快捷键一览");
      kbdBg.addEventListener("click", (ev) => {
        const downTarget = _localDialogDownTarget;
        _localDialogDownTarget = null;
        if (ev.target === kbdBg && (!downTarget || downTarget === kbdBg)) closeLocalShortcutsCheatsheet();
      });
      document.body.appendChild(kbdBg);
    }
    kbdBg.replaceChildren();
    const card = document.createElement("div");
    card.className = "local-kbd-card";

    const head = document.createElement("div");
    head.className = "local-kbd-head";
    const title = document.createElement("h3");
    title.textContent = "⌨️ 本地协同快捷键一览";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "local-kbd-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => closeLocalShortcutsCheatsheet());
    head.appendChild(title);
    head.appendChild(closeBtn);
    card.appendChild(head);

    const sections = [
      {
        title: "导航与会话",
        rows: [
          ["快速切换房间与指令面板", [mod, "K"]],
          ["搜索当前房间消息", [mod, "F"]],
          ["跳转下一处 / 上一处搜索匹配", [mod, "G", "/", shift, "Enter"]],
          ["切换上 / 下一个会话", [alt, "↑", "/", "↓"]],
          ["跳转上 / 下一个未读会话", [alt, shift, "↑", "/", "↓"]],
          ["切换浅色 / 深色模式", ["T"]],
          ["打开快捷键一览", ["?"]],
        ],
      },
      {
        title: "消息与编辑",
        rows: [
          ["聚焦消息输入框", [mod, "/"]],
          ["发送消息 / 插入换行", ["Enter", "/", shift, "Enter"]],
          ["粗体 / 斜体 / 行内代码", [mod, "B", "/", "I", "/", "E"]],
          ["编辑上一条发出的消息（空输入框）", ["↑"]],
          ["唤起 @ 成员自动补全", ["@"]],
          ["看图缩放 / 1:1 / 旋转 / 复制", ["+", "−", "1", "R", "C"]],
          ["关闭浮层 / 退出搜索", ["Esc"]],
        ],
      },
      {
        title: isMac ? "桌面客户端（macOS）" : "桌面客户端",
        rows: [
          ["快捷切换工作区（Cloud / 本地 / Studio / OKR）", [mod, "1", "–", "6"]],
          ["复制当前页面链接 / 本机 MCP 命令", [mod, shift, "C"]],
          ["启动 / 停止内置本机 Server", [mod, shift, "L"]],
          ...(isMac ? [["全局截屏并自动粘贴到聊天", ["⌘", "⇧", "X"]]] : []),
          ["切换窗口置顶", [mod, shift, "T"]],
          ["静音 / 恢复桌面通知", [mod, shift, "M"]],
          ["重置窗口大小并居中", [mod, shift, "0"]],
          ["界面放大 / 缩小 / 还原默认", [mod, "+", "/", "−", "/", "0"]],
        ],
      },
    ];

    for (const sec of sections) {
      const h = document.createElement("div");
      h.className = "local-kbd-sec";
      h.textContent = sec.title;
      card.appendChild(h);
      for (const [label, keys] of sec.rows) {
        const row = document.createElement("div");
        row.className = "local-kbd-row";
        const sp = document.createElement("span");
        sp.textContent = label;
        const kWrap = document.createElement("span");
        kWrap.className = "local-kbd-keys";
        for (const k of keys) {
          if (k === "/" && keys.length > 2) {
            const sep = document.createElement("span");
            sep.className = "local-kbd-sep";
            sep.textContent = "/";
            kWrap.appendChild(sep);
            continue;
          }
          const el = document.createElement("kbd");
          el.textContent = k;
          kWrap.appendChild(el);
        }
        row.appendChild(sp);
        row.appendChild(kWrap);
        card.appendChild(row);
      }
    }

    kbdBg.appendChild(card);
    kbdBg.hidden = false;
    closeBtn.focus();
  }

  // WeChat macOS 4.0 Resizable Sidebar Split-Pane (220px–420px, double-click resets to 276px)
  const LOCAL_SB_W_KEY = "ac_local_sidebar_width";
  const LOCAL_SB_DEFAULT_W = 276;
  function applyLocalSidebarWidth(px, persist) {
    const clamped = Math.max(220, Math.min(420, Math.round(Number(px) || LOCAL_SB_DEFAULT_W)));
    document.documentElement.style.setProperty("--local-sb-w", `${clamped}px`);
    if (persist) {
      try {
        localStorage.setItem(LOCAL_SB_W_KEY, String(clamped));
      } catch {}
    }
    return clamped;
  }
  try {
    const savedW = Number(localStorage.getItem(LOCAL_SB_W_KEY));
    if (Number.isFinite(savedW) && savedW >= 220 && savedW <= 420) {
      applyLocalSidebarWidth(savedW, false);
    }
  } catch {}
  const elSidebarResizer = document.getElementById("local-sidebar-resizer");
  if (elSidebarResizer) {
    let dragging = false;
    elSidebarResizer.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      elSidebarResizer.classList.add("dragging");
      document.body.classList.add("resizing-sidebar");
      if (typeof elSidebarResizer.setPointerCapture === "function") {
        try {
          elSidebarResizer.setPointerCapture(ev.pointerId);
        } catch {}
      }
      ev.preventDefault();
    });
    const onMove = (ev) => {
      if (!dragging) return;
      applyLocalSidebarWidth(ev.clientX, false);
    };
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      elSidebarResizer.classList.remove("dragging");
      document.body.classList.remove("resizing-sidebar");
      applyLocalSidebarWidth(ev.clientX, true);
    };
    elSidebarResizer.addEventListener("pointermove", onMove);
    elSidebarResizer.addEventListener("pointerup", onUp);
    elSidebarResizer.addEventListener("pointercancel", onUp);
    elSidebarResizer.addEventListener("dblclick", () => {
      applyLocalSidebarWidth(LOCAL_SB_DEFAULT_W, true);
      showToast("已还原侧边栏默认宽度");
    });
  }

  window._acLocalUi = {
    toggleChannelPin,
    setUnreadFilter(unreadOnly) {
      sidebarUnreadOnly = Boolean(unreadOnly);
      updateUnreadFilterUI();
      renderChannelList();
    },
    openShortcutsCheatsheet: openLocalShortcutsCheatsheet,
    closeShortcutsCheatsheet: closeLocalShortcutsCheatsheet,
    openChannelContextMenu,
    openLocalImageLightbox,
    closeLocalImageLightbox,
    getLightboxState: () => ({ ...localLbState, total: localLbState.items.length }),
    stepSearchMatch: (delta) => stepSearchMatch(delta),
    getSearchMatchState: () => ({ total: searchMatchEls.length, index: searchMatchIdx }),
    isSafeLocalImageUrl,
    autoResizeLocalInput,
    syncComposerState,
    renderMessagesSkeleton,
  };

  document.getElementById("btn-quick-switcher")?.addEventListener("click", () => {
    openLocalSwitcher();
  });

  // Capture-phase Lightbox shortcuts (prevents Escape from cancelling underlying composer replyTarget)
  window.addEventListener("keydown", (ev) => {
    if (!localLbState.open) return;
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeLocalImageLightbox(); return; }
    if (ev.key === "ArrowLeft") { ev.preventDefault(); ev.stopPropagation(); lbStep(-1); return; }
    if (ev.key === "ArrowRight") { ev.preventDefault(); ev.stopPropagation(); lbStep(1); return; }
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); ev.stopPropagation(); lbSetScaleAt(localLbState.scale + 0.25, null, null, false); return; }
    if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); ev.stopPropagation(); lbSetScaleAt(localLbState.scale - 0.25, null, null, false); return; }
    if (ev.key === "0") { ev.preventDefault(); ev.stopPropagation(); lbResetTransform(); return; }
    if (ev.key === "1") {
      ev.preventDefault();
      ev.stopPropagation();
      if (localLbState.scale > 1.05) {
        localLbState.scale = 1; localLbState.tx = 0; localLbState.ty = 0; lbApplyTransform(false);
      } else {
        lbSetScaleAt(2.5, null, null, false);
      }
      return;
    }
    if (ev.key === "r" || ev.key === "R") {
      ev.preventDefault();
      ev.stopPropagation();
      localLbState.rotate = (localLbState.rotate + (ev.shiftKey ? 270 : 90)) % 360;
      const cl = lbClampPan(localLbState.tx, localLbState.ty, localLbState.scale);
      localLbState.tx = cl.tx; localLbState.ty = cl.ty;
      lbApplyTransform(false);
      return;
    }
    if ((ev.key === "c" || ev.key === "C") && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      void lbCopyImage();
      return;
    }
    if ((ev.key === "d" || ev.key === "D") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      lbDownloadImage();
      return;
    }
  }, true);

  // Global shortcuts: Cmd/Ctrl+K command palette, Cmd/Ctrl+F search room, Cmd/Ctrl+G match stepper, ? shortcuts modal, Alt+Up/Down switch channel, Esc close/clear
  window.addEventListener("keydown", (ev) => {
    if (localLbState.open) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "g" && activeSearchQuery && searchMatchEls.length > 0) {
      ev.preventDefault();
      stepSearchMatch(ev.shiftKey ? -1 : 1);
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      if (switcherBg && !switcherBg.hidden) closeLocalSwitcher();
      else openLocalSwitcher();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && (ev.key === "/" || ev.key === "?")) {
      ev.preventDefault();
      if (kbdBg && !kbdBg.hidden) closeLocalShortcutsCheatsheet();
      else openLocalShortcutsCheatsheet();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key === "/") {
      const anyModal = !!document.querySelector(".modal-backdrop:not([hidden]), dialog[open]");
      if (!anyModal && elInput) {
        ev.preventDefault();
        closeLocalSwitcher();
        closeLocalShortcutsCheatsheet();
        elInput.focus();
        const end = elInput.value.length;
        try { elInput.setSelectionRange(end, end); } catch {}
        return;
      }
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      closeLocalSwitcher();
      closeLocalShortcutsCheatsheet();
      elSearchInput?.focus();
      elSearchInput?.select();
      return;
    }
    if (ev.key === "Escape" && ctxMenuEl) {
      ev.preventDefault();
      closeChannelContextMenu(true);
      return;
    }
    if (ev.key === "Escape" && kbdBg && !kbdBg.hidden) {
      ev.preventDefault();
      closeLocalShortcutsCheatsheet();
      return;
    }
    if (ev.key === "Escape" && switcherBg && !switcherBg.hidden) {
      ev.preventDefault();
      closeLocalSwitcher();
      return;
    }
    if ((ev.key === "?" || ev.key === "t" || ev.key === "T") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const active = document.activeElement;
      const tag = active ? String(active.tagName || "").toUpperCase() : "";
      const editable = !!(
        active &&
        (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable)
      );
      const anyModal = !!document.querySelector(".modal-backdrop:not([hidden]), dialog[open]");
      if (!editable && !anyModal && (!switcherBg || switcherBg.hidden)) {
        if (ev.key === "?") {
          ev.preventDefault();
          if (kbdBg && !kbdBg.hidden) closeLocalShortcutsCheatsheet();
          else openLocalShortcutsCheatsheet();
          return;
        }
        if (!kbdBg || kbdBg.hidden) {
          ev.preventDefault();
          document.getElementById("btn-toggle-theme")?.click();
          return;
        }
      }
    }
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
      const anyModal = !!document.querySelector(".modal-backdrop:not([hidden]), dialog[open]");
      if (anyModal || ctxMenuEl || (switcherBg && !switcherBg.hidden) || (kbdBg && !kbdBg.hidden)) {
        return;
      }
      const ordered = getOrderedChannels().map((entry) => entry.ch);
      if (ordered.length > 0) {
        ev.preventDefault();
        const curIdx = ordered.findIndex((c) => c.id === currentChannelId);
        const base = curIdx >= 0 ? curIdx : 0;
        const delta = ev.key === "ArrowDown" ? 1 : -1;
        if (ev.shiftKey) {
          let found = null;
          for (let step = 1; step <= ordered.length; step++) {
            const candidate = ordered[(base + delta * step + ordered.length * step) % ordered.length];
            if (candidate && candidate.id !== currentChannelId && (unreadByChannel.get(candidate.id) || 0) > 0) {
              found = candidate;
              break;
            }
          }
          if (found) {
            void selectChannel(found.id);
          } else {
            showToast("当前没有未读会话");
          }
        } else if (ordered.length > 1) {
          const nextCh = ordered[(base + delta + ordered.length) % ordered.length];
          if (nextCh && nextCh.id !== currentChannelId) {
            void selectChannel(nextCh.id);
          }
        }
      }
      return;
    }
    if (ev.key === "Escape" && activeSearchQuery) {
      ev.preventDefault();
      document.getElementById("btn-clear-search")?.click();
      return;
    }
    if (ev.key === "Escape" && replyTarget) {
      const anyModal = !!document.querySelector(".modal-backdrop:not([hidden]), dialog[open]");
      if (!anyModal && (!elMentionMenu || elMentionMenu.hidden)) {
        ev.preventDefault();
        setReplyTarget(null);
      }
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
    openNativeDialog(dlg);
  });

  document.getElementById("btn-close-connect").addEventListener("click", () => {
    document.getElementById("connect-dialog").close();
  });

  const btnToggleLan = document.getElementById("btn-toggle-lan");
  btnToggleLan?.addEventListener("click", async () => {
    if (!bridge?.toggleAllowLan || !bridge?.getServerStatus || btnToggleLan.disabled) return;
    const prevLabel = btnToggleLan.textContent;
    btnToggleLan.disabled = true;
    btnToggleLan.textContent = "切换中…";
    btnToggleLan.setAttribute("aria-busy", "true");
    try {
      const cur = await bridge.getServerStatus();
      const next = !Boolean(cur?.allowLan);
      const res = await bridge.toggleAllowLan(next);
      if (res?.ok) {
        showToast(next ? "已开放局域网接入 (0.0.0.0)" : "已切回仅本机回环 (127.0.0.1)");
        await refreshConnectModal();
      } else {
        btnToggleLan.textContent = prevLabel;
        showToast("局域网设置切换失败，请稍后重试");
      }
    } catch {
      btnToggleLan.textContent = prevLabel;
      showToast("局域网设置切换失败，请稍后重试");
    } finally {
      btnToggleLan.disabled = false;
      btnToggleLan.removeAttribute("aria-busy");
    }
  });

  function selectHarnessTab(btn, shouldFocus = false) {
    if (!btn) return;
    activeHarness = btn.dataset.harness || "claude";
    for (const el of document.querySelectorAll("#snippet-tabs .tab-btn")) {
      const selected = el === btn;
      el.classList.toggle("active", selected);
      el.setAttribute("aria-selected", String(selected));
      el.setAttribute("tabindex", selected ? "0" : "-1");
    }
    if (shouldFocus && typeof btn.focus === "function") {
      try { btn.focus(); } catch {}
    }
    document.getElementById("mcp-snippet-box").textContent = buildHarnessSnippet(
      activeHarness,
      activeConnectBaseUrl,
    );
  }

  const elSnippetTabs = document.getElementById("snippet-tabs");
  elSnippetTabs?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab-btn");
    if (!btn) return;
    selectHarnessTab(btn, false);
  });
  elSnippetTabs?.addEventListener("keydown", (ev) => {
    const tabs = Array.from(elSnippetTabs.querySelectorAll(".tab-btn"));
    if (!tabs.length) return;
    const curIdx = tabs.indexOf(document.activeElement);
    if (curIdx < 0) return;
    let nextIdx = -1;
    if (ev.key === "ArrowRight") nextIdx = (curIdx + 1) % tabs.length;
    else if (ev.key === "ArrowLeft") nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
    else if (ev.key === "Home") nextIdx = 0;
    else if (ev.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx >= 0) {
      ev.preventDefault();
      selectHarnessTab(tabs[nextIdx], true);
    }
  });

  document.getElementById("btn-copy-snippet").addEventListener("click", async (ev) => {
    const txt = document.getElementById("mcp-snippet-box").textContent || "";
    if (bridge?.copyText) await bridge.copyText(txt);
    else await navigator.clipboard?.writeText(txt);
    flashCopyButton(ev.currentTarget, "复制配置命令");
    showToast("已复制 MCP 接入配置");
  });

  const btnRefreshBots = document.getElementById("btn-refresh-bots");
  btnRefreshBots?.addEventListener("click", async () => {
    if (btnRefreshBots.disabled) return;
    btnRefreshBots.disabled = true;
    btnRefreshBots.classList.add("spinning");
    try {
      await loadDiscoveredBots();
      showToast(`已刷新本机 Agent（检测到 ${discoveredProfilesCache.length} 个）`);
    } finally {
      btnRefreshBots.disabled = false;
      btnRefreshBots.classList.remove("spinning");
    }
  });
  document.getElementById("btn-go-cloud").addEventListener("click", () => {
    if (bridge?.switchToCloud) bridge.switchToCloud("/cloud-agents");
    else window.open("https://agents-chat.com/cloud-agents", "_blank", "noopener");
  });
  document.getElementById("btn-go-marketplace")?.addEventListener("click", () => {
    if (bridge?.switchToCloud) bridge.switchToCloud("/marketplace");
    else window.open("https://agents-chat.com/marketplace", "_blank", "noopener");
  });

  document.getElementById("btn-cancel-reply")?.addEventListener("click", () => setReplyTarget(null));

  function focusSearchMatch(idx) {
    if (!searchMatchEls.length) {
      searchMatchIdx = -1;
      if (elSearchMatchCount) {
        elSearchMatchCount.textContent = "0 / 0";
        elSearchMatchCount.hidden = !activeSearchQuery;
      }
      if (elBtnSearchPrev) elBtnSearchPrev.disabled = true;
      if (elBtnSearchNext) elBtnSearchNext.disabled = true;
      return;
    }
    const norm = ((idx % searchMatchEls.length) + searchMatchEls.length) % searchMatchEls.length;
    searchMatchEls.forEach((el, i) => el.classList.toggle("current", i === norm));
    searchMatchIdx = norm;
    const activeEl = searchMatchEls[norm];
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      try { activeEl.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
    }
    if (elSearchMatchCount) {
      elSearchMatchCount.textContent = `${norm + 1} / ${searchMatchEls.length}`;
      elSearchMatchCount.hidden = false;
    }
    if (elBtnSearchPrev) elBtnSearchPrev.disabled = searchMatchEls.length <= 1;
    if (elBtnSearchNext) elBtnSearchNext.disabled = searchMatchEls.length <= 1;
  }

  function syncSearchMatches() {
    if (!activeSearchQuery || !elMessages) {
      searchMatchEls = [];
      searchMatchIdx = -1;
      if (elSearchMatchCount) elSearchMatchCount.hidden = true;
      if (elBtnSearchPrev) elBtnSearchPrev.disabled = true;
      if (elBtnSearchNext) elBtnSearchNext.disabled = true;
      return;
    }
    searchMatchEls = Array.from(elMessages.querySelectorAll("mark.search-hit"));
    if (searchMatchEls.length > 0) {
      focusSearchMatch(0);
    } else {
      focusSearchMatch(-1);
    }
  }

  function stepSearchMatch(delta) {
    if (!searchMatchEls.length) return;
    const base = searchMatchIdx < 0 ? 0 : searchMatchIdx;
    focusSearchMatch(base + (delta < 0 ? -1 : 1));
  }

  async function runSearch(query) {
    const q = String(query || "").trim();
    if (!q) {
      activeSearchQuery = "";
      searchMatchEls = [];
      searchMatchIdx = -1;
      if (elSearchBanner) elSearchBanner.hidden = true;
      if (elSearchMatchCount) elSearchMatchCount.hidden = true;
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
      elSearchBannerText.textContent = `在 #${currentChannelId} 中搜索 “${q}”：命中 ${messages.length} 条消息`;
    }
    renderMessages();
  }

  elBtnSearchPrev?.addEventListener("click", () => stepSearchMatch(-1));
  elBtnSearchNext?.addEventListener("click", () => stepSearchMatch(1));
  elSearchInput?.addEventListener("input", () => {
    if (activeSearchQuery && !elSearchInput.value.trim()) {
      void runSearch("");
    }
  });
  elSearchInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeComposing(ev)) {
      ev.preventDefault();
      const val = elSearchInput.value.trim();
      if (val && val === activeSearchQuery && searchMatchEls.length > 0) {
        stepSearchMatch(ev.shiftKey ? -1 : 1);
      } else {
        void runSearch(elSearchInput.value);
      }
    } else if (ev.key === "Escape") {
      elSearchInput.value = "";
      elSearchInput.blur();
      if (activeSearchQuery) {
        void runSearch("");
      }
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
    openNativeDialog(document.getElementById("settings-dialog"));
  });
  document.getElementById("btn-close-settings")?.addEventListener("click", () => {
    document.getElementById("settings-dialog").close();
  });
  let savingLocalSettings = false;
  document.getElementById("settings-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!bridge?.updateLocalSettings || savingLocalSettings) return;
    const portInput = document.getElementById("setting-port");
    const port = Number(portInput?.value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      showToast("监听端口须为 1024 - 65535 之间的整数");
      portInput?.focus();
      portInput?.select?.();
      return;
    }
    const allowLan = document.getElementById("setting-allow-lan").checked;
    const minimizeToTray = document.getElementById("setting-minimize-tray").checked;
    const launchAtLogin = document.getElementById("setting-launch-login").checked;
    const saveBtn = document.getElementById("btn-save-settings");
    savingLocalSettings = true;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      saveBtn.setAttribute("aria-busy", "true");
    }
    try {
      const res = await bridge.updateLocalSettings({ localServerPort: port, allowLan, minimizeToTray, launchAtLogin });
      if (res?.ok) {
        document.getElementById("settings-dialog").close();
        showToast(`设置已保存（${res.status?.httpUrl || ""}）`);
      } else {
        showToast("保存设置失败，请稍后重试");
      }
    } catch {
      showToast("保存设置失败，请稍后重试");
    } finally {
      savingLocalSettings = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "保存并生效";
        saveBtn.removeAttribute("aria-busy");
      }
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
    openNativeDialog(document.getElementById("registered-dialog"));
    await loadDiscoveredBots();
    await selectChannel(currentChannelId);
  });
  document.getElementById("btn-close-registered")?.addEventListener("click", () => {
    document.getElementById("registered-dialog").close();
  });
  document.getElementById("btn-copy-registered-cmd")?.addEventListener("click", async (ev) => {
    if (!latestRegisteredCmd) return;
    if (bridge?.copyText) await bridge.copyText(latestRegisteredCmd);
    else await navigator.clipboard?.writeText(latestRegisteredCmd);
    flashCopyButton(ev.currentTarget, "复制本机 MCP 命令");
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

  // `@mention` Autocomplete Popover (Online-first, CJK display names, ARIA listbox & hover/scroll sync)
  function syncMentionActiveVisual(scrollIntoView = false) {
    if (!elMentionMenu) return;
    const opts = Array.from(elMentionMenu.querySelectorAll(".mention-opt"));
    let activeOpt = null;
    opts.forEach((opt, i) => {
      const isAct = i === mentionActiveIdx;
      opt.classList.toggle("active", isAct);
      opt.setAttribute("aria-selected", String(isAct));
      if (isAct) activeOpt = opt;
    });
    if (elInput) {
      if (activeOpt && activeOpt.id) elInput.setAttribute("aria-activedescendant", activeOpt.id);
      else elInput.removeAttribute("aria-activedescendant");
    }
    if (scrollIntoView && activeOpt && typeof activeOpt.scrollIntoView === "function") {
      try { activeOpt.scrollIntoView({ block: "nearest" }); } catch {}
    }
  }

  function closeMentionMenu() {
    mentionCandidates = [];
    mentionActiveIdx = 0;
    if (elMentionMenu) {
      elMentionMenu.hidden = true;
      elMentionMenu.replaceChildren();
    }
    if (elInput) {
      elInput.setAttribute("aria-expanded", "false");
      elInput.removeAttribute("aria-activedescendant");
    }
  }

  function applyMentionSelection(agentId) {
    const pos = elInput.selectionStart ?? elInput.value.length;
    const before = elInput.value.slice(0, pos);
    const after = elInput.value.slice(pos);
    const replaced = before.replace(/(^|\s)@([^\s@]{0,40})$/, `$1@${agentId} `);
    elInput.value = replaced + after;
    const nextPos = replaced.length;
    elInput.setSelectionRange(nextPos, nextPos);
    elInput.focus();
    saveLocalDraft(currentChannelId, elInput.value);
    syncComposerState();
    closeMentionMenu();
  }

  function updateMentionMenu() {
    if (!elMentionMenu) return;
    const pos = elInput.selectionStart ?? elInput.value.length;
    const before = elInput.value.slice(0, pos);
    const match = before.match(/(^|\s)@([^\s@]{0,40})$/);
    if (!match) {
      closeMentionMenu();
      return;
    }
    const q = (match[2] || "").toLowerCase();
    mentionCandidates = currentMembers
      .filter(
        (m) =>
          m.agent_id !== currentPrincipal?.id &&
          (m.agent_id.toLowerCase().includes(q) || (m.display_name || "").toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const onlineDiff = Number(Boolean(b.online)) - Number(Boolean(a.online));
        if (onlineDiff !== 0) return onlineDiff;
        const nameA = String(a.display_name || a.agent_id || "");
        const nameB = String(b.display_name || b.agent_id || "");
        return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
      });
    if (mentionCandidates.length === 0) {
      closeMentionMenu();
      return;
    }
    mentionActiveIdx = Math.max(0, Math.min(mentionActiveIdx, mentionCandidates.length - 1));
    elMentionMenu.replaceChildren();
    mentionCandidates.forEach((m, idx) => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.id = `local-mention-opt-${idx}`;
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(idx === mentionActiveIdx));
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
      opt.addEventListener("mouseenter", () => {
        if (mentionActiveIdx !== idx) {
          mentionActiveIdx = idx;
          syncMentionActiveVisual(false);
        }
      });
      opt.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyMentionSelection(m.agent_id);
      });
      elMentionMenu.appendChild(opt);
    });
    elMentionMenu.hidden = false;
    if (elInput) elInput.setAttribute("aria-expanded", "true");
    syncMentionActiveVisual(true);
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
    saveLocalDraft(currentChannelId, elInput.value);
    syncComposerState();
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
    if (isImeComposing(ev)) return;
    if (mentionCandidates.length > 0 && elMentionMenu && !elMentionMenu.hidden) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        mentionActiveIdx = (mentionActiveIdx + 1) % mentionCandidates.length;
        syncMentionActiveVisual(true);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        mentionActiveIdx = (mentionActiveIdx - 1 + mentionCandidates.length) % mentionCandidates.length;
        syncMentionActiveVisual(true);
        return;
      }
      if (ev.key === "Home") {
        ev.preventDefault();
        mentionActiveIdx = 0;
        syncMentionActiveVisual(true);
        return;
      }
      if (ev.key === "End") {
        ev.preventDefault();
        mentionActiveIdx = mentionCandidates.length - 1;
        syncMentionActiveVisual(true);
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
    if (ev.key === "ArrowUp" && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (elInput.value === "" && currentPrincipal?.id && messages.length > 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const item = messages[i];
          if (item && item.id && item.sender_id === currentPrincipal.id && typeof item.content === "string" && item.content) {
            ev.preventDefault();
            void editLocalMessage(item);
            return;
          }
        }
      }
    }
    if (ev.key === "Escape" && replyTarget) {
      ev.preventDefault();
      setReplyTarget(null);
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && !isImeComposing(ev)) {
      const k = ev.key.toLowerCase();
      if (k === "b" || k === "i" || k === "e") {
        ev.preventDefault();
        const wrap = k === "b" ? "**" : k === "i" ? "*" : "`";
        const start = elInput.selectionStart ?? elInput.value.length;
        const end = elInput.selectionEnd ?? start;
        const sel = elInput.value.slice(start, end);
        elInput.value = elInput.value.slice(0, start) + wrap + sel + wrap + elInput.value.slice(end);
        elInput.focus();
        elInput.setSelectionRange(start + wrap.length, start + wrap.length + sel.length);
        saveLocalDraft(currentChannelId, elInput.value);
        syncComposerState();
        return;
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.altKey && !isImeComposing(ev)) {
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
    const roomLabel = (elRoomTitle?.textContent || `#${leavingId}`).trim();
    const confirmed = await openConfirmDialog({
      title: `退出群聊 ${roomLabel}？`,
      hint: "退出后你将不再收到此本地群聊的新消息；已保存的本地消息记录与本机 Agent 身份仍会保留。",
      confirmText: "确认退出",
      cancelText: "留在群聊",
      danger: true,
    });
    if (!confirmed) return;
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

  ["prompt-dialog", "connect-dialog", "settings-dialog", "registered-dialog"].forEach((id) => {
    bindDialogBackdropClose(document.getElementById(id));
  });

  // Boot
  applyLocalPlatformShortcuts();
  syncComposerState();
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
