// Conservative markdown formatting pass applied just before a comment/review body is posted, plus
// small pure formatting helpers for the IO boundary (e.g. the sticky's posted-at timestamp).
// Pure string transform: never reflows content, never touches fenced code blocks (a `suggestion`
// block's blank lines and trailing whitespace are significant and must survive verbatim).

interface ScanState {
  readonly lines: readonly string[];
  readonly inFence: boolean;
  readonly blankRun: number;
}

const FENCE_RE = /^\s*```/;

const scanLine = (state: ScanState, line: string): ScanState => {
  if (FENCE_RE.test(line)) {
    return { lines: [...state.lines, line], inFence: !state.inFence, blankRun: 0 };
  }
  if (state.inFence) {
    return { lines: [...state.lines, line], inFence: true, blankRun: 0 };
  }
  const trimmed = line.replace(/[ \t]+$/, "");
  if (trimmed !== "") {
    return { lines: [...state.lines, trimmed], inFence: false, blankRun: 0 };
  }
  const blankRun = state.blankRun + 1;
  return blankRun === 1
    ? { lines: [...state.lines, ""], inFence: false, blankRun }
    : { ...state, blankRun };
};

/** Trim trailing whitespace and collapse runs of 2+ blank lines to one — never to zero — leaving
 *  exactly one trailing newline. Fenced (```) content passes through untouched. */
export const formatMarkdown = (md: string): string => {
  const { lines } = md
    .split("\n")
    .reduce<ScanState>(scanLine, { lines: [], inFence: false, blankRun: 0 });
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Format a Date as UTC `YYYY-MM-DD HH:MM UTC`, for the sticky's "Reviewed `<sha>` · <postedAt>"
 *  line (issue #28). Computed at the IO boundary (index.ts's post/render commands) — `render()`
 *  itself stays pure/clockless and just receives the formatted string. */
export const formatUtc = (d: Date): string =>
  `${String(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
