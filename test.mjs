import { strict as assert } from "node:assert";
import { analyzeTranscript } from "./app.js";
import { deepgramListenUrl, extractDeepgramTranscript, openRouterModelId } from "./server.js";

const result = analyzeTranscript(
  "Either we ban AI completely or schools will collapse and nobody will learn anything anymore.",
  "Either we ban AI completely or schools will collapse and nobody will learn anything anymore.",
  []
);

assert(result.flags.some((flag) => flag.type === "false_dilemma"));
assert(result.flags.some((flag) => flag.type === "slippery_slope"));
assert(result.scores.logic < 8);
assert.equal(extractDeepgramTranscript({
  results: { channels: [{ alternatives: [{ transcript: " Hello world. " }] }] }
}), "Hello world.");
assert(deepgramListenUrl().includes("model=nova-3"));
assert(deepgramListenUrl().includes("interim_results=true"));
assert.equal(openRouterModelId(), process.env.OPENROUTER_MODEL || "google/gemini-3.1-flash-lite");
console.log("ok");
