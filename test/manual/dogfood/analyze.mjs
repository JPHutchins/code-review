import { readFileSync } from "node:fs";

const path = process.argv[2];
const lines = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const entries = lines
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const ts = (e) => (e.timestamp ? Date.parse(e.timestamp) : null);
const first = entries
  .map(ts)
  .filter((t) => t != null)
  .sort((a, b) => a - b)[0];
const off = (e) => {
  const t = ts(e);
  return t == null ? "  ?  " : `${((t - first) / 1000).toFixed(1)}s`.padStart(6);
};

const phaseOf = (s) =>
  /STOP all new investigation/.test(s) ? "HARD-deny" : /Wind down/.test(s) ? "soft-steer" : null;

let cumIn = 0;
let cumOut = 0;
for (const e of entries) {
  const s = JSON.stringify(e);
  if (e.type === "assistant" && e.message) {
    const u = e.message.usage ?? {};
    cumIn += u.input_tokens ?? 0;
    cumOut += u.output_tokens ?? 0;
    const tools = (e.message.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        const t = b.input?.file_path ?? b.input?.command ?? b.input?.pattern ?? "";
        return `${b.name}(${String(t).slice(0, 42)})`;
      });
    const txt = (e.message.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    const stop = e.message.stop_reason ?? "";
    console.log(
      `${off(e)}  #A in=${String(cumIn).padStart(7)} out=${String(cumOut).padStart(6)}  ${stop.padEnd(10)} ${tools.length ? tools.join(", ") : txt ? "«" + txt.slice(0, 60).replace(/\n/g, " ") + "»" : "(none)"}`,
    );
  } else {
    const deny = /Other tools are blocked/.test(s) && /tool_result|toolUseResult|is_error/.test(s);
    const ph = phaseOf(s);
    if (deny)
      console.log(
        `${off(e)}  ⛔ DENIED tool result (budget hard-block reason returned to a tool call)`,
      );
    else if (ph) console.log(`${off(e)}  ↪  injected ${ph}`);
  }
}
console.log(`\nTOTAL cumulative: in=${cumIn} out=${cumOut}`);
