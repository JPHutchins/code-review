// Conservative markdown formatting pass applied just before a comment/review body is posted.
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
