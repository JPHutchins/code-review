// The untrusted review agent's network jail as one sandbox-runtime (`srt`) settings file (data, not
// shell). The allowlist is the model endpoint the CLI actually dials plus the GitHub API/host and any
// consumer-supplied hosts; the host-side proxy denies everything else. Filesystem isolation is off —
// the threat this closes is network exfil of the burner key, not the throwaway runner's disk — so the
// jail confines only egress while the agent still reads the worktree and writes its draft freely.

export interface SandboxConfig {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
  };
  readonly filesystem: {
    readonly allowRead: readonly string[];
    readonly denyRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
}

// GitHub hosts the agent may reach when it shells out to gh/git during a review.
const GITHUB_HOSTS = ["api.github.com", "github.com"] as const;

// The model host from api_base_url (ANTHROPIC_BASE_URL) — the single source of truth for the endpoint
// the CLI dials, rather than a hardcoded vendor. Bare hostname (no scheme/port/path) to match the
// proxy's hostname rule. Throws rather than yield an empty entry that would deny the model itself.
export const deriveModelHost = (apiBaseUrl: string): string => {
  const host = URL.canParse(apiBaseUrl) ? new URL(apiBaseUrl).hostname : "";
  if (host === "") {
    throw new Error(
      `could not derive the model host from api_base_url ${JSON.stringify(apiBaseUrl)} — expected a URL like https://api.deepseek.com/anthropic`,
    );
  }
  return host;
};

// Model-provider host suffixes the derived allowlist entry is expected to match. The jail auto-derives
// its sole egress allowlist from api_base_url, so a typo'd or stale value now fails OPEN — it dials, and
// hands MODEL_API_KEY to, whatever host that variable names (the old fixed, PR-reviewed allowlist failed
// CLOSED instead). A derived host outside these well-known providers is warned about loudly by the
// `sandbox-config` command rather than allowlisted silently.
const KNOWN_MODEL_HOST_SUFFIXES = ["anthropic.com", "deepseek.com"] as const;

// True when host is one of the known providers or a subdomain of one; the `.`-prefixed suffix check
// keeps the boundary honest (notanthropic.com and api.anthropic.com.evil.com are both unknown).
export const isKnownModelHost = (host: string): boolean =>
  KNOWN_MODEL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

// The consumer's extra_endpoints: the same whitespace-separated host[:port] list they already pass to
// harden-runner. Ports are dropped — the proxy matches on hostname (the only form validated on the
// runner), and for HTTPS-only egress a port scope adds nothing.
export const parseExtraEndpoints = (extra: string): readonly string[] =>
  extra
    .split(/\s+/)
    .map((token) => token.replace(/:\d+$/, ""))
    .filter((token) => token.length > 0);

export const buildSandboxConfig = (opts: {
  readonly apiBaseUrl: string;
  readonly extra?: string;
}): SandboxConfig => ({
  network: {
    allowedDomains: [
      ...new Set([
        deriveModelHost(opts.apiBaseUrl),
        ...GITHUB_HOSTS,
        ...parseExtraEndpoints(opts.extra ?? ""),
      ]),
    ],
    deniedDomains: [],
  },
  filesystem: { allowRead: [], denyRead: [], allowWrite: ["/"], denyWrite: [] },
});
