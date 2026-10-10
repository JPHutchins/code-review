import * as t from "io-ts";

export const DispositionCodec = t.keyof({ fixed: null, refuted: null, dismissed: null });
export type Disposition = t.TypeOf<typeof DispositionCodec>;

// The response vocabulary, for every surface that teaches it.
export const DISPOSITIONS = Object.keys(DispositionCodec.keys) as readonly Disposition[];

// What a harvested answer records: the taught vocabulary, or `unstated` when a table row answers in
// words that name no verdict — never a guess, and never a closure.
export const ResponseDispositionCodec = t.keyof({
  fixed: null,
  refuted: null,
  dismissed: null,
  unstated: null,
});
export type ResponseDisposition = t.TypeOf<typeof ResponseDispositionCodec>;

export const RESPONSE_FORM = `Review-Response: <id> ${DISPOSITIONS.join("|")} — <reason>`;

// The answer table's columns, named in the teaching's prose — never shown as bytes to copy — and
// spelled into the header and delimiter a written answer table carries.
export const RESPONSE_TABLE_COLUMNS = ["id", "disposition", "reason"] as const;
export const RESPONSE_TABLE_HEADER = `| ${RESPONSE_TABLE_COLUMNS.join(" | ")} |`;
export const RESPONSE_TABLE_DELIMITER = `| ${RESPONSE_TABLE_COLUMNS.map(() => "---").join(" | ")} |`;

const listed = (words: readonly string[], conjunction: "and" | "or"): string => {
  const quoted = words.map((word) => `\`${word}\``);
  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} ${conjunction} ${quoted.at(-1) ?? ""}`;
};

// What the implementer is told, word for word, on the sticky under every full review with findings.
// It stands alone: it names the table's columns rather than pointing at a rendered example, so any
// template that renders it teaches the whole form.
export const RESPONSE_TEACHING = `To answer findings, post a PR conversation comment holding a rendered markdown table, not one inside a code block, whose columns are ${listed(RESPONSE_TABLE_COLUMNS, "and")}, one row per finding id, its disposition exactly one of ${listed(DISPOSITIONS, "or")}; or put \`${RESPONSE_FORM}\` lines in a commit message. Inline-thread replies are not read. A systemic problem's id, when shown, answers its whole class.`;
