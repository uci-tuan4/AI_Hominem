const demoLines = [
  "If we let students use AI, nobody will learn anything anymore. Teachers will become useless, schools will collapse, and employers will never trust graduates again.",
  "The other side only supports AI because they do not care whether students can think for themselves.",
  "My cousin used an AI tutor and passed calculus, so clearly every school should replace homework with AI coaching.",
  "Either we ban AI from classrooms completely or we accept that cheating is now normal.",
  "I am not saying there are no benefits, but nobody has shown how schools will preserve original thinking at scale."
];

const rules = [
  {
    type: "slippery_slope",
    severity: "medium",
    confidence: 0.78,
    test: /nobody will learn|schools will collapse|never trust/i,
    explanation: "Predicts an extreme outcome without evidence.",
    followUp: "What evidence supports that chain of outcomes?"
  },
  {
    type: "unsupported_claim",
    severity: "medium",
    confidence: 0.72,
    test: /clearly|everyone|nobody|never|always|useless/i,
    explanation: "Makes a broad claim without support.",
    followUp: "What data or source supports that claim?"
  },
  {
    type: "false_dilemma",
    severity: "high",
    confidence: 0.82,
    test: /either .* or |ban .* completely|only two/i,
    explanation: "Frames the choice as narrower than it is.",
    followUp: "What middle-ground options are being excluded?"
  },
  {
    type: "ad_hominem",
    severity: "low",
    confidence: 0.68,
    test: /do not care|doesn't care|ignorant|stupid/i,
    explanation: "Attacks motive or character instead of the argument.",
    followUp: "Can you answer the argument without judging the person?"
  },
  {
    type: "anecdotal_evidence",
    severity: "low",
    confidence: 0.7,
    test: /my cousin|my friend|one time|in my experience/i,
    explanation: "Uses one example as if it proves the broader point.",
    followUp: "Is there broader evidence beyond that example?"
  }
];

let segments = [];
let flags = [];
let facts = [];
let recognition;
let recorder;
let mediaStream;
let streamSocket;
let micActive = false;
let analyzeTimer;
let factTimer;
let demoTimer;
let lastAnalyzed = 0;
let lastFactChecked = 0;
let partialText = "";
let deepgramFailed = false;
let factChecking = false;

const isBrowser = typeof document !== "undefined";
const $ = (id) => document.getElementById(id);

const statusEl = isBrowser ? $("status") : null;
const transcriptEl = isBrowser ? $("transcript") : null;
const flagsEl = isBrowser ? $("flags") : null;
const factsEl = isBrowser ? $("facts") : null;
const startBtn = isBrowser ? $("startBtn") : null;
const stopBtn = isBrowser ? $("stopBtn") : null;
const demoBtn = isBrowser ? $("demoBtn") : null;

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function analyzeTranscript(recentTranscript, contextTranscript = recentTranscript, previousFlags = []) {
  const seen = new Set(previousFlags.map((flag) => `${flag.type}:${flag.quote.toLowerCase()}`));
  const found = [];

  for (const rule of rules) {
    if (!rule.test.test(recentTranscript)) continue;
    const sentence = recentTranscript.split(/[.!?]/).find((part) => rule.test.test(part)) || recentTranscript;
    const quote = sentence.trim().slice(0, 140);
    const key = `${rule.type}:${quote.toLowerCase()}`;
    if (seen.has(key)) continue;
    found.push({
      type: rule.type,
      quote,
      severity: rule.severity,
      confidence: rule.confidence,
      explanation: rule.explanation,
      followUp: rule.followUp
    });
  }

  const penalty = found.reduce((sum, flag) => sum + (flag.severity === "high" ? 2 : flag.severity === "medium" ? 1.25 : .75), 0);
  const evidencePenalty = found.some((flag) => flag.type === "unsupported_claim" || flag.type === "anecdotal_evidence") ? 2 : 0;
  const logicPenalty = found.some((flag) => flag.type === "false_dilemma" || flag.type === "slippery_slope") ? 2 : 0;
  const civilityPenalty = found.some((flag) => flag.type === "ad_hominem") ? 2 : 0;
  const clarity = Math.max(1, Math.round(8 - penalty / 2));

  return {
    flags: found.slice(0, 5),
    scores: {
      clarity,
      evidence: Math.max(1, 8 - evidencePenalty - Math.round(penalty / 3)),
      logic: Math.max(1, 8 - logicPenalty - Math.round(penalty / 3)),
      responsiveness: Math.max(1, contextTranscript.includes("?") ? 7 : 6),
      civility: Math.max(1, 9 - civilityPenalty)
    },
    summary: found.length
      ? `Flagged ${found.length} issue${found.length === 1 ? "" : "s"} in the latest argument.`
      : "No clear reasoning issues in the latest chunk."
  };
}

function setRunning(running, label) {
  statusEl.textContent = label;
  startBtn.disabled = running;
  stopBtn.disabled = !running;
}

function resetSession() {
  segments = [];
  flags = [];
  facts = [];
  partialText = "";
  deepgramFailed = false;
  lastAnalyzed = 0;
  lastFactChecked = 0;
  factChecking = false;
  renderTranscript();
  renderFlags();
  renderFacts();
  updateScores({ clarity: 7, evidence: 7, logic: 7, responsiveness: 7, civility: 7 });
  $("summary").textContent = "Analysis appears every 15 seconds and after Stop.";
}

function addSegment(text, isFinal = true) {
  const clean = text.trim();
  if (!clean) return;
  segments.push({
    id: crypto.randomUUID(),
    text: clean,
    startedAt: Date.now(),
    endedAt: Date.now(),
    isFinal
  });
  renderTranscript();
}

function renderTranscript() {
  transcriptEl.innerHTML = "";
  if (!segments.length) {
    transcriptEl.innerHTML = '<p class="empty">Start the mic or run the demo.</p>';
  } else {
    for (const [index, segment] of segments.entries()) {
      const p = document.createElement("p");
      p.className = `segment${index === segments.length - 1 ? " newest" : ""}`;
      p.textContent = segment.text;
      transcriptEl.append(p);
    }
  }
  if (partialText) {
    const p = document.createElement("p");
    p.className = "segment partial newest";
    p.textContent = partialText;
    transcriptEl.append(p);
  }
  $("wordCount").textContent = `${words(`${segments.map((s) => s.text).join(" ")} ${partialText}`).length} words`;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderFlags() {
  flagsEl.innerHTML = "";
  const latest = flags.slice(-5).reverse();
  if (!latest.length) {
    flagsEl.innerHTML = '<p class="empty">No issues flagged yet.</p>';
  } else {
    for (const flag of latest) {
      const card = document.createElement("article");
      card.className = `flag ${flag.severity}`;
      card.innerHTML = `
        <h3>${flag.type.replaceAll("_", " ")}</h3>
        <p class="quote">"${escapeHtml(flag.quote)}"</p>
        <p>${escapeHtml(flag.explanation)}</p>
        <p class="follow-up">${escapeHtml(flag.followUp)}</p>
        <p class="meta">${flag.severity} severity · ${Math.round(flag.confidence * 100)}% confidence</p>
      `;
      flagsEl.append(card);
    }
  }
  $("flagCount").textContent = `${flags.length} flag${flags.length === 1 ? "" : "s"}`;
}

function renderFacts() {
  factsEl.innerHTML = "";
  const latest = facts.slice(-5).reverse();
  if (!latest.length) {
    factsEl.innerHTML = '<p class="empty">No claims checked yet.</p>';
  } else {
    for (const fact of latest) {
      const card = document.createElement("article");
      card.className = `fact ${fact.verdict}`;
      const sources = (fact.sources || []).slice(0, 2).map((source) =>
        `<p class="source"><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title || source.url)}</a></p>`
      ).join("");
      card.innerHTML = `
        <h3>${escapeHtml(fact.verdict)}</h3>
        <p class="quote">"${escapeHtml(fact.claim)}"</p>
        <p>${escapeHtml(fact.explanation)}</p>
        ${sources}
      `;
      factsEl.append(card);
    }
  }
  $("factCount").textContent = `${facts.length} checked`;
}

function updateScores(scores) {
  for (const [key, value] of Object.entries(scores)) {
    const row = document.querySelector(`.score[data-key="${key}"]`);
    row.querySelector("meter").value = value;
    row.querySelector("span").textContent = value;
  }
}

async function runAnalysis(force = false) {
  const newSegments = segments.slice(lastAnalyzed);
  const recentTranscript = newSegments.map((s) => s.text).join(" ");
  if (!force && words(recentTranscript).length < 25) return;

  const contextTranscript = segments.slice(-12).map((s) => s.text).join(" ");
  const payload = {
    recentTranscript: recentTranscript || contextTranscript,
    contextTranscript,
    previousFlags: flags.slice(-10).map((flag) => `${flag.type}: ${flag.quote}`)
  };
  let result;
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("AI analysis unavailable.");
    result = await response.json();
  } catch {
    result = analyzeTranscript(payload.recentTranscript, contextTranscript, flags);
  }
  flags = flags.concat(result.flags).slice(-20);
  lastAnalyzed = segments.length;
  renderFlags();
  updateScores(result.scores);
  $("summary").textContent = result.summary;
}

async function runFactCheck(force = false) {
  if (factChecking) return;
  const newSegments = segments.slice(lastFactChecked);
  const recentTranscript = newSegments.map((s) => s.text).join(" ");
  if (!force && words(recentTranscript).length < 35) return;

  factChecking = true;
  try {
    const response = await fetch("/api/fact-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recentTranscript: recentTranscript || segments.slice(-8).map((s) => s.text).join(" "),
        contextTranscript: segments.slice(-16).map((s) => s.text).join(" "),
        previousClaims: facts.slice(-10).map((fact) => fact.claim)
      })
    });
    if (!response.ok) throw new Error("Fact check unavailable.");
    const fact = await response.json();
    if (fact.claim) {
      facts = facts.concat(fact).slice(-20);
      renderFacts();
    }
    lastFactChecked = segments.length;
  } catch {
    lastFactChecked = segments.length;
  } finally {
    factChecking = false;
  }
}

function startMic() {
  stopAll(false);
  resetSession();
  if (navigator.mediaDevices && window.MediaRecorder) {
    startDeepgramMic();
    return;
  }

  startBrowserMic();
}

async function startDeepgramMic() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micActive = true;
    startDeepgramStream();
  } catch {
    startBrowserMic();
  }
}

function startDeepgramStream() {
  streamSocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/transcribe-stream`);
  streamSocket.onopen = () => {
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size && streamSocket?.readyState === WebSocket.OPEN) streamSocket.send(event.data);
    };
    recorder.onerror = () => {
      statusEl.textContent = "Deepgram recording failed.";
      stopAll(false);
    };
    recorder.start(250);
    analyzeTimer = setInterval(() => runAnalysis(false), 15000);
    factTimer = setInterval(() => runFactCheck(false), 30000);
    setRunning(true, "Streaming with Deepgram Nova-3");
  };
  streamSocket.onmessage = (event) => {
    try {
      const result = JSON.parse(event.data);
      if (result.error) throw new Error(result.error);
      const transcript = result.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript) return;
      if (result.is_final) {
        partialText = "";
        addSegment(transcript);
        runAnalysis(false);
      } else {
        partialText = transcript;
        renderTranscript();
      }
    } catch (error) {
      deepgramFailed = true;
      stopAll(false);
      statusEl.textContent = error.message;
    }
  };
  streamSocket.onerror = () => {
    deepgramFailed = true;
    stopAll(false);
    statusEl.textContent = "Deepgram stream failed.";
  };
  streamSocket.onclose = () => {
    if (micActive && !deepgramFailed) {
      stopAll(false);
      statusEl.textContent = "Deepgram stream closed.";
    }
  };
}

function startBrowserMic() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    statusEl.textContent = "Speech recognition unavailable. Running demo.";
    startDemo();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onresult = (event) => {
    partialText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) addSegment(event.results[i][0].transcript);
      else partialText += event.results[i][0].transcript;
    }
    renderTranscript();
  };
  recognition.onerror = () => {
    statusEl.textContent = "Mic failed. Running demo.";
    startDemo();
  };
  recognition.onend = () => clearInterval(analyzeTimer);
  recognition.start();
  analyzeTimer = setInterval(() => runAnalysis(false), 15000);
  factTimer = setInterval(() => runFactCheck(false), 30000);
  setRunning(true, "Listening");
}

function startDemo() {
  stopAll(false);
  resetSession();
  setRunning(true, "Demo running");
  let index = 0;
  demoTimer = setInterval(() => {
    addSegment(demoLines[index]);
    runAnalysis(true);
    runFactCheck(true);
    index++;
    if (index === demoLines.length) stopAll(true);
  }, 1800);
}

function stopAll(finalize = true) {
  micActive = false;
  if (recognition) recognition.stop();
  if (recorder && recorder.state !== "inactive") recorder.stop();
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  clearInterval(analyzeTimer);
  clearInterval(factTimer);
  clearInterval(demoTimer);
  recognition = null;
  recorder = null;
  mediaStream = null;
  if (streamSocket && streamSocket.readyState <= WebSocket.OPEN) streamSocket.close();
  streamSocket = null;
  partialText = "";
  renderTranscript();
  if (finalize) runAnalysis(true);
  if (finalize) runFactCheck(true);
  setRunning(false, segments.length ? "Stopped" : "Ready");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

if (isBrowser) {
  startBtn.addEventListener("click", startMic);
  stopBtn.addEventListener("click", () => stopAll(true));
  demoBtn.addEventListener("click", startDemo);
}
