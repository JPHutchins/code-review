// The release date, stamped by scripts/bump_version.py at release time. The staleness signal for
// the price map (issue #220): a map whose `_updated` predates this date cannot reflect pricing the
// CLI ships — the warn fires exactly when a consumer rolled the CLI but not the prices.
export const RELEASED = "2026-10-02";
