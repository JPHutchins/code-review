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

// Built-in model-provider host suffixes the derived allowlist entry is expected to match. The jail
// auto-derives its sole egress allowlist from api_base_url, so a typo'd or stale value now fails OPEN —
// it dials, and hands MODEL_API_KEY to, whatever host that variable names (the old fixed, PR-reviewed
// allowlist failed CLOSED instead). A derived host outside these providers (and any consumer-declared
// host) is warned about loudly by the `sandbox-config` command, or rejected under `--strict-host`.
const KNOWN_MODEL_HOST_SUFFIXES = ["anthropic.com", "deepseek.com"] as const;

// True when host is a built-in provider (or a subdomain of one — the `.`-prefixed suffix keeps the
// boundary honest, so notanthropic.com and api.anthropic.com.evil.com are both unknown), or an EXACT
// match for a consumer-declared host. A consumer on another provider declares their endpoint so it
// passes while a typo of it (a different exact string) does not. Both sides are normalized (lowercased,
// trailing FQDN dot dropped) so a case/dot variant of a declared host still matches — deriveModelHost
// returns a URL-parser-lowercased hostname while a declared token is preserved as typed.
export const isKnownModelHost = (host: string, declared: readonly string[] = []): boolean => {
  const normalize = (h: string): string => h.replace(/\.$/, "").toLowerCase();
  const target = normalize(host);
  return (
    declared.some((d) => normalize(d) === target) ||
    KNOWN_MODEL_HOST_SUFFIXES.some((suffix) => target === suffix || target.endsWith(`.${suffix}`))
  );
};

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
