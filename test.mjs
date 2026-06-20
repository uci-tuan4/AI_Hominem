import { strict as assert } from "node:assert";
import { analyzeTranscript } from "./app.js";

const result = analyzeTranscript(
  "Either we ban AI completely or schools will collapse and nobody will learn anything anymore.",
  "Either we ban AI completely or schools will collapse and nobody will learn anything anymore.",
  []
);

assert(result.flags.some((flag) => flag.type === "false_dilemma"));
assert(result.flags.some((flag) => flag.type === "slippery_slope"));
assert(result.scores.logic < 8);
console.log("ok");
