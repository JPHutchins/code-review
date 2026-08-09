// The `scope` workflow input — the languages/inputs a project accepts — surfaced to the review agent
// so it can triage "is this input a program the project accepts?" BEFORE assigning severities (issue
// #139). Pure parse + grammar; the CLI's `check-scope` command is the only caller, so the grammar the
// prompt is built from and the grammar the tests pin are the same code.

// A scope value is spliced into the review agent's system prompt, so the characters that break prompt
// structure are rejected: newline/carriage-return (starts a new block), backtick (closes a code span),
// `<`/`>` (close an HTML comment), and `|` (breaks a markdown table) — exactly the set in SCOPE_UNSAFE.
// The value is trusted consumer config, but a malformed splice would silently corrupt the instruction.
// Everything else printable and structure-safe is accepted (C++, C#, C/C++, Objective-C). A multi-word
// name is not a unit here — whitespace separates tokens, so spell a multi-word name with a dash (e.g.
// "visual-basic") or list its words separately.
const SCOPE_UNSAFE = /[\n\r`<>|]/;

export type ScopeParse =
  // Empty/whitespace — no declared scope; the reviewer infers it from the README's first paragraph.
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly languages: readonly string[] }
  // Malformed — the CLI fails loudly so a config typo surfaces, never a corrupted prompt.
  | { readonly kind: "invalid"; readonly reason: string };

// Whitespace, commas, and semicolons are interchangeable separators ("C C++", "c, c++", "python; rust").
// The separator consumes surrounding whitespace, so a split token carries none (no per-token trim).
const SCOPE_SEPARATOR_RE = /[\s,;]+/;

export const parseScope = (raw: string | undefined): ScopeParse => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return { kind: "absent" };
  if (SCOPE_UNSAFE.test(trimmed)) {
    return {
      kind: "invalid",
      reason:
        'scope contains a character (newline, carriage return, backtick, "<", ">", or "|") that would corrupt the review prompt — use plain language names/tags',
    };
  }
  // De-duplicate preserving first-seen order; a value that was only separators (" , ; ") declares
  // nothing, so it reads as absent rather than an empty scope.
  const languages = Array.from(new Set(trimmed.split(SCOPE_SEPARATOR_RE).filter((t) => t !== "")));
  return languages.length === 0 ? { kind: "absent" } : { kind: "ok", languages };
};
