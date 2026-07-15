// Fenced code blocks pass through verbatim — a `suggestion` block's blank lines and trailing
// whitespace are significant.

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

export const formatMarkdown = (md: string): string => {
  const { lines } = md
    .split("\n")
    .reduce<ScanState>(scanLine, { lines: [], inFence: false, blankRun: 0 });
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Computed at the IO boundary so render() stays pure/clockless.
export const formatUtc = (d: Date): string =>
  `${String(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
