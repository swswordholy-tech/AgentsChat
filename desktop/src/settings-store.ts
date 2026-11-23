import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_UPSTREAM_SERVER_URL } from "./identity-authority.js";
import type { DesktopSettings } from "./types.js";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  activeWorkspace: "cloud",
  theme: "light",
  remoteServerUrl: DEFAULT_UPSTREAM_SERVER_URL,
  localServerEnabled: true,
  localServerPort: 8787,
  allowLan: false,
  minimizeToTray: true,
  launchAtLogin: false,
};

export function sanitizeDesktopSettings(raw: Partial<DesktopSettings> | null | undefined): DesktopSettings {
  const s = raw && typeof raw === "object" ? raw : {};
  let remoteServerUrl = DEFAULT_DESKTOP_SETTINGS.remoteServerUrl;
  if (typeof s.remoteServerUrl === "string" && s.remoteServerUrl.trim()) {
    try {
      const u = new URL(s.remoteServerUrl.trim().replace(/\/+$/, ""));
      if (u.protocol === "https:" && !u.username && !u.password) {
        remoteServerUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      }
    } catch {}
  }
  const rawPort = Number(s.localServerPort);
  const localServerPort =
    Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535
      ? rawPort
      : DEFAULT_DESKTOP_SETTINGS.localServerPort;

  let windowBounds: DesktopSettings["windowBounds"];
  if (s.windowBounds && typeof s.windowBounds === "object") {
    const bw = Math.round(Number(s.windowBounds.width));
    const bh = Math.round(Number(s.windowBounds.height));
    if (Number.isFinite(bw) && Number.isFinite(bh) && bw >= 880 && bw <= 4096 && bh >= 560 && bh <= 2400) {
      const bx = s.windowBounds.x !== undefined ? Math.round(Number(s.windowBounds.x)) : undefined;
      const by = s.windowBounds.y !== undefined ? Math.round(Number(s.windowBounds.y)) : undefined;
      windowBounds = {
        width: bw,
        height: bh,
        ...(bx !== undefined && Number.isFinite(bx) && bx >= -4096 && bx <= 8192 ? { x: bx } : {}),
        ...(by !== undefined && Number.isFinite(by) && by >= -4096 && by <= 8192 ? { y: by } : {}),
      };
    }
  }

  return {
    activeWorkspace: s.activeWorkspace === "local" ? "local" : "cloud",
    theme: s.theme === "dark" ? "dark" : "light",
    remoteServerUrl,
    localServerEnabled: s.localServerEnabled !== false,
    localServerPort,
    allowLan: s.allowLan === true,
    minimizeToTray: s.minimizeToTray !== false,
    launchAtLogin: s.launchAtLogin === true,
    ...(windowBounds ? { windowBounds } : {}),
  };
}

export class DesktopSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): DesktopSettings {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULT_DESKTOP_SETTINGS };
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return sanitizeDesktopSettings(parsed);
    } catch {
      return { ...DEFAULT_DESKTOP_SETTINGS };
    }
  }

  save(patch: Partial<DesktopSettings>): DesktopSettings {
    const current = this.load();
    const next = sanitizeDesktopSettings({ ...current, ...patch });
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    return next;
  }
}
