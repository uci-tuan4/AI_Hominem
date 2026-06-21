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
    test: /clearly|obviously|everyone|nobody|never|always|useless|causes?|proves?|guarantees?|destroys?|fixes?|leads to|makes .* (better|worse|useless|dangerous)/i,
    skip: /stupid|ignorant|idiot|moron/i,
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
let currentMode = "mic";
let micActive = false;
let analyzeTimer;
let factTimer;
let demoTimer;
let lastAnalyzed = 0;
let lastFactChecked = 0;
let partialText = "";
let deepgramFailed = false;
let analyzing = false;
let factChecking = false;
const minAnalysisWords = 3;

const isBrowser = typeof document !== "undefined";
const $ = (id) => document.getElementById(id);

const statusEl = isBrowser ? $("status") : null;
const transcriptEl = isBrowser ? $("transcript") : null;
const flagsEl = isBrowser ? $("flags") : null;
const factsEl = isBrowser ? $("facts") : null;
const startBtn = isBrowser ? $("startBtn") : null;
const stopBtn = isBrowser ? $("stopBtn") : null;
const demoBtn = isBrowser ? $("demoBtn") : null;
const sensitivityEl = isBrowser ? $("sensitivity") : null;
const modeButtons = isBrowser ? Array.from(document.querySelectorAll(".mode")) : [];

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function isFlag(flag) {
  return flag && flag.type && flag.quote;
}

function flagKey(flag) {
  return `${flag.type}:${normalizeQuote(flag.quote)}`;
}

function normalizeQuote(quote) {
  return String(quote || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function flagRank(flag) {
  const severity = { high: 3, medium: 2, low: 1 }[flag.severity] || 0;
  return severity + (Number(flag.confidence) || 0);
}

function overlaps(a, b) {
  return a === b || (a.length > 8 && b.includes(a)) || (b.length > 8 && a.includes(b));
}

export function mergeNewFlags(existingFlags, candidateFlags) {
  const merged = existingFlags.filter(isFlag).map((flag) => ({ flag, existing: true }));

  for (const flag of candidateFlags.filter(isFlag)) {
    const quote = normalizeQuote(flag.quote);
    const index = merged.findIndex((item) =>
      item.flag.type === flag.type && overlaps(normalizeQuote(item.flag.quote), quote)
    );
    if (index === -1) {
      merged.push({ flag, existing: false });
    } else if (!merged[index].existing && flagRank(flag) > flagRank(merged[index].flag)) {
      merged[index] = { flag, existing: false };
    }
  }

  return merged.filter((item) => !item.existing).map((item) => item.flag).slice(0, 5);
}

function clip(text, max = 90) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function flagTitle(flag) {
  return String(flag.type || "flag").replaceAll("_", " ");
}

function counterQuestion(flag) {
  return flag.followUp || "What is the strongest answer to this?";
}

async function notifyFlags(newFlags) {
  for (const flag of newFlags) {
    if (window.aiHominem?.notifyFlag) {
      window.aiHominem.notifyFlag(flag);
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`AI Hominem: ${flagTitle(flag)}`, {
        body: counterQuestion(flag)
      });
    } else if ("Notification" in window && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        new Notification(`AI Hominem: ${flagTitle(flag)}`, {
          body: counterQuestion(flag)
        });
      }
    }
  }
}

export function analyzeTranscript(recentTranscript, contextTranscript = recentTranscript, previousFlags = []) {
  const seen = new Set(previousFlags.map((flag) => `${flag.type}:${flag.quote.toLowerCase()}`));
  const found = [];

  for (const rule of rules) {
    if (!rule.test.test(recentTranscript)) continue;
    if (rule.skip?.test(recentTranscript)) continue;
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

  return {
    flags: found.slice(0, 5)
  };
}

function setRunning(running, label) {
  statusEl.textContent = label;
  statusEl.classList.toggle("listening", running);
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  modeButtons.forEach((button) => {
    button.disabled = running;
  });
}

function setMode(mode) {
  currentMode = mode;
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  statusEl.textContent = mode === "desktop" ? "Ready for desktop audio" : "Ready for mic audio";
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
      const sources = (fact.sources || []).slice(0, 1).map((source) =>
        `<p class="source"><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title || source.url)}</a></p>`
      ).join("");
      card.innerHTML = `
        <h3>${escapeHtml(fact.verdict)}</h3>
        <p>${escapeHtml(clip(fact.explanation, 80))}</p>
        <p class="meta">${escapeHtml(clip(fact.claim, 80))}</p>
        ${sources}
      `;
      factsEl.append(card);
    }
  }
  $("factCount").textContent = `${facts.length} checked`;
}

async function runAnalysis(force = false) {
  if (analyzing) return;
  const newSegments = segments.slice(lastAnalyzed);
  const recentTranscript = newSegments.map((s) => s.text).join(" ");
  if (!force && words(recentTranscript).length < minAnalysisWords) return;

  analyzing = true;
  const contextTranscript = segments.slice(-12).map((s) => s.text).join(" ");
  const payload = {
    recentTranscript: recentTranscript || contextTranscript,
    contextTranscript,
    previousFlags: flags.slice(-10).map((flag) => `${flag.type}: ${flag.quote}`),
    sensitivity: sensitivityEl?.value || "medium"
  };
  const localResult = analyzeTranscript(payload.recentTranscript, contextTranscript, flags);
  let result;
  try {
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error("AI analysis unavailable.");
      result = await response.json();
    } catch {
      result = localResult;
    }
    result.flags = mergeNewFlags(flags, localResult.flags.concat(result.flags || []));
    flags = flags.concat(result.flags).slice(-20);
    lastAnalyzed = segments.length;
    renderFlags();
    notifyFlags(result.flags);
  } finally {
    analyzing = false;
  }
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

function startListening() {
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
    mediaStream = currentMode === "desktop"
      ? await getDesktopAudioStream()
      : await navigator.mediaDevices.getUserMedia({ audio: true });
    micActive = true;
    startDeepgramStream();
  } catch {
    if (currentMode === "mic") startBrowserMic();
    else statusEl.textContent = "Desktop audio unavailable.";
  }
}

async function getDesktopAudioStream() {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error("Desktop capture unsupported.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  const audioTracks = stream.getAudioTracks();
  stream.getVideoTracks().forEach((track) => track.stop());
  if (!audioTracks.length) throw new Error("No desktop audio selected.");
  return new MediaStream(audioTracks);
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
    setRunning(true, `Streaming ${currentMode} audio with Deepgram Nova-3`);
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
  startBtn.addEventListener("click", startListening);
  stopBtn.addEventListener("click", () => stopAll(true));
  demoBtn.addEventListener("click", startDemo);
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
}
