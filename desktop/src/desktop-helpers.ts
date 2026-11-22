export interface ParsedDeepLink {
  workspace: "cloud" | "local";
  path?: string;
  channelId?: string;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string;
  error?: string;
}

export const GITHUB_RELEASES_API_URL =
  "https://api.github.com/repos/swswordholy-tech/AgentsChat/releases?per_page=15";
export const GITHUB_RELEASES_WEB_URL =
  "https://github.com/swswordholy-tech/AgentsChat/releases";

/**
 * Safely parse an `agentschat://` deep link for macOS (`open-url`) and Windows (`second-instance`).
 * Examples:
 *   agentschat://cloud                -> { workspace: "cloud", path: "/" }
 *   agentschat://cloud/cloud-agents   -> { workspace: "cloud", path: "/cloud-agents" }
 *   agentschat://local                -> { workspace: "local" }
 *   agentschat://local/my-group       -> { workspace: "local", channelId: "my-group" }
 *
 * Strictly rejects open redirects (`//evil.com`, backslashes, `@`, control chars) and unknown schemes.
 */
export function parseDeepLink(rawUrl: string): ParsedDeepLink | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return null;
  if (trimmed.includes("..") || /%2e%2e/i.test(trimmed) || trimmed.includes("\\") || /[\r\n\0]/.test(trimmed)) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "agentschat:") return null;
  if (u.username || u.password) return null;

  const host = u.hostname.toLowerCase();
  const rawPath = u.pathname || "/";
  if (rawPath.includes("//")) {
    return null;
  }

  if (host === "local") {
    const seg = rawPath.replace(/^\/+|\/+$/g, "");
    if (!seg) return { workspace: "local" };
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(seg) && !seg.includes("..")) {
      return { workspace: "local", channelId: seg };
    }
    return { workspace: "local" };
  }

  if (host === "cloud" || host === "open" || host === "") {
    const cleanPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    if (cleanPath.includes("..")) return null;
    const search = u.search && !/[\r\n\0]/.test(u.search) ? u.search : "";
    return { workspace: "cloud", path: `${cleanPath}${search}` };
  }

  return null;
}

export function parseDesktopReleaseTag(tagName: string): string | null {
  const m = String(tagName || "").trim().match(/^desktop-v(\d+)\.(\d+)\.(\d+)$/i);
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = String(a || "0.0.0")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0.0.0")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkLatestDesktopRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<DesktopUpdateCheckResult> {
  try {
    const res = await fetchImpl(GITHUB_RELEASES_API_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `AgentsChat-Desktop/${currentVersion}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return {
        checked: false,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: GITHUB_RELEASES_WEB_URL,
        error: `GitHub API returned HTTP ${res.status}`,
      };
    }
    const list = (await res.json()) as Array<{
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    let bestVersion: string | null = null;
    let bestUrl = GITHUB_RELEASES_WEB_URL;
    for (const rel of Array.isArray(list) ? list : []) {
      if (rel.draft || rel.prerelease) continue;
      const ver = parseDesktopReleaseTag(rel.tag_name || "");
      if (!ver) continue;
      if (!bestVersion || compareSemver(ver, bestVersion) > 0) {
        bestVersion = ver;
        if (typeof rel.html_url === "string" && rel.html_url.startsWith("https://github.com/")) {
          bestUrl = rel.html_url;
        }
      }
    }
    const hasUpdate = Boolean(bestVersion && compareSemver(bestVersion, currentVersion) > 0);
    return {
      checked: true,
      currentVersion,
      latestVersion: bestVersion,
      hasUpdate,
      releaseUrl: bestUrl,
    };
  } catch (err: any) {
    return {
      checked: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: GITHUB_RELEASES_WEB_URL,
      error: String(err?.message || "Network error"),
    };
  }
}
