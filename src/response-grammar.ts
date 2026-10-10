import * as t from "io-ts";

export const DispositionCodec = t.keyof({ fixed: null, refuted: null, dismissed: null });
export type Disposition = t.TypeOf<typeof DispositionCodec>;

// The response vocabulary, for every surface that teaches it.
export const DISPOSITIONS = Object.keys(DispositionCodec.keys) as readonly Disposition[];

// A maintainer's ruling on a contested id: a vocabulary of its own, taught only beside the contested
// ids it rules on, and never part of the answer instructions.
export const RulingCodec = t.keyof({ upheld: null, overruled: null });
export type Ruling = t.TypeOf<typeof RulingCodec>;
export const RULINGS = Object.keys(RulingCodec.keys) as readonly Ruling[];

// What a harvested answer records: the taught vocabulary, a ruling, or `unstated` when a table row
// answers in words that name no verdict — never a guess, and never a closure.
export const ResponseDispositionCodec = t.keyof({
  fixed: null,
  refuted: null,
  dismissed: null,
  upheld: null,
  overruled: null,
  unstated: null,
});

export const isAnswerWord = (word: unknown): word is Disposition | Ruling =>
  DispositionCodec.is(word) || RulingCodec.is(word);
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
export const RULING_FORM = `Review-Response: <id> ${RULINGS.join("|")} — <reason>`;

export const RULING_TEACHING = `A maintainer rules on a contested finding by answering its id, in a table row or a \`${RULING_FORM}\` commit line, with \`upheld\` (the finding stands at full weight until it is fixed) or \`overruled\` (it is closed for good).`;

export const RESPONSE_TEACHING = `To answer findings, post a PR conversation comment holding a rendered markdown table, not one inside a code block, whose columns are ${listed(RESPONSE_TABLE_COLUMNS, "and")}, one row per finding id, its disposition exactly one of ${listed(DISPOSITIONS, "or")}; or put \`${RESPONSE_FORM}\` lines in a commit message. Inline-thread replies are not read. A systemic problem's id, when shown, answers its whole class.`;
