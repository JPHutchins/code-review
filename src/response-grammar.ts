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

export const RESPONSE_TABLE_HEADER = "| id | disposition | reason |";
export const RESPONSE_TABLE_DELIMITER = "| --- | --- | --- |";

// The table the sticky shows under its teaching, as a fenced block an implementer copies whole and
// fills in: the header, the delimiter, and one example row.
export const RESPONSE_TABLE_EXAMPLE = [
  RESPONSE_TABLE_HEADER,
  RESPONSE_TABLE_DELIMITER,
  `| <id> | ${DISPOSITIONS.at(0) ?? ""} | <reason> |`,
].join("\n");

// What the implementer is told, word for word, on the sticky under every full review with findings.
export const RESPONSE_TEACHING = `To answer findings, post a PR conversation comment holding the table below, one row per finding id, its disposition exactly one of ${DISPOSITIONS.slice(
  0,
  -1,
)
  .map((disposition) => `\`${disposition}\``)
  .join(
    ", ",
  )} or \`${DISPOSITIONS.at(-1) ?? ""}\`; or put \`${RESPONSE_FORM}\` lines in a commit message. Inline-thread replies are not read. A systemic problem's id, when shown, answers its whole class.`;
