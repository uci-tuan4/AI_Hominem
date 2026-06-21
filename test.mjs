import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { analyzeTranscript, mergeNewFlags } from "./app.js";
import { deepgramListenUrl, extractDeepgramTranscript, normalizeAnalysis, openRouterModelId, shouldSkipFactCheck } from "./server.js";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const html = readFileSync("index.html", "utf8");
const electronMain = readFileSync("electron/main.js", "utf8");
const electronPreload = readFileSync("electron/preload.cjs", "utf8");

assert.equal(packageJson.main, "electron/main.js");
assert.equal(packageJson.scripts.desktop, "electron .");
assert(html.includes('data-mode="mic"'));
assert(html.includes('data-mode="desktop"'));
assert(electronMain.includes("new Tray("));
assert(electronMain.includes("backgroundThrottling: false"));
assert(electronMain.includes("setDisplayMediaRequestHandler"));
assert(electronMain.includes("new Notification("));
assert(electronMain.includes('display notification ${quotedBody} with title ${quotedTitle}'));
assert(electronMain.includes('notification.on("click", showMainWindow)'));
assert(electronMain.includes('const title = `AI Hominem: ${String(flag.type || "flag").replaceAll("_", " ")}`'));
assert(electronMain.includes('const body = flag.followUp || "What is the strongest answer to this?"'));
assert(electronPreload.includes("notifyFlag"));

const result = analyzeTranscript(
  "Either we ban AI completely or schools will collapse and nobody will learn anything anymore.",
  "Either we ban AI completely or schools will collapse and nobody will learn anything anymore.",
  []
);

assert(result.flags.some((flag) => flag.type === "false_dilemma"));
assert(result.flags.some((flag) => flag.type === "slippery_slope"));

const shortUnsupported = analyzeTranscript("AI destroys creativity.", "AI destroys creativity.", []);
assert(shortUnsupported.flags.some((flag) => flag.type === "unsupported_claim"));
assert.deepEqual(normalizeAnalysis({ flags: ["Factual inaccuracy"] }).flags, []);
const confidenceFlags = { flags: [
  { type: "unsupported_claim", quote: "a", confidence: 0.9 },
  { type: "unsupported_claim", quote: "b", confidence: 0.5 }
] };
assert.equal(normalizeAnalysis(confidenceFlags).flags.length, 2);
assert.equal(normalizeAnalysis(confidenceFlags, 0.6).flags.length, 1);
assert.equal(mergeNewFlags(shortUnsupported.flags, shortUnsupported.flags).length, 0);
assert.equal(mergeNewFlags(shortUnsupported.flags, [{
  ...shortUnsupported.flags[0],
  quote: "AI  destroys   creativity."
}]).length, 0);

const insult = analyzeTranscript("Your point does not make sense because you are stupid.", "", []);
assert(insult.flags.some((flag) => flag.type === "ad_hominem"));
assert(!insult.flags.some((flag) => flag.type === "unsupported_claim"));

const duplicateInsults = mergeNewFlags([], [
  {
    type: "ad_hominem",
    quote: "because you are stupid",
    severity: "high",
    confidence: 1,
    explanation: "",
    followUp: ""
  },
  {
    type: "ad_hominem",
    quote: "you are stupid",
    severity: "high",
    confidence: 1,
    explanation: "",
    followUp: ""
  },
  ...insult.flags
]);
assert.equal(duplicateInsults.filter((flag) => flag.type === "ad_hominem").length, 1);

assert.equal(extractDeepgramTranscript({
  results: { channels: [{ alternatives: [{ transcript: " Hello world. " }] }] }
}), "Hello world.");
assert(deepgramListenUrl().includes("model=nova-3"));
assert(deepgramListenUrl().includes("interim_results=true"));
assert.equal(openRouterModelId(), process.env.OPENROUTER_MODEL || "google/gemini-3.1-flash-lite");
assert.equal(shouldSkipFactCheck("The moon is made of cheese."), true);
console.log("ok");
