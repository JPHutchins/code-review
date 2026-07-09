import assert from "node:assert";
import { inRange, clamp, parseRange } from "./range.js";

assert.equal(inRange("1-10", 1), true, "1 is in [1,10]");
assert.equal(inRange("1-10", 10), true, "10 is in [1,10]");
assert.equal(inRange("-5-5", -5), true, "-5 is in [-5,5]");
assert.equal(clamp("1-10", 0), 1, "clamp below lo");
assert.deepEqual(parseRange("-5-5"), { lo: -5, hi: 5 }, "negative lower bound");
console.log("ok");
