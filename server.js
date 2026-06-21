import { createReadStream, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const maxAudioBytes = 25 * 1024 * 1024;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

const port = process.env.PORT || 4173;
const host = "127.0.0.1";
const defaultOpenRouterModel = "google/gemini-3.1-flash-lite";

// Controls how aggressively the analyzer flags claims. Override with
// ANALYSIS_SENSITIVITY=low|medium|high (default: medium). `minConfidence` is a
// hard post-filter; `guidance` steers the model's own threshold.
const sensitivityProfiles = {
  low: {
    minConfidence: 0.8,
    guidance: "Be conservative: flag only egregious, clear-cut fallacies and central claims asserted as fact with no support whatsoever. Ignore hedged, qualified, or offhand statements. When in doubt, do not flag."
  },
  medium: {
    minConfidence: 0.6,
    guidance: "Flag substantive unsupported claims and clear fallacies. Skip trivial, hedged, or well-qualified statements."
  },
  high: {
    minConfidence: 0,
    guidance: "Flag every factual claim stated without evidence and any potential fallacy, even minor ones."
  }
};

export function analysisProfile(name) {
  const key = String(name || process.env.ANALYSIS_SENSITIVITY || "medium").toLowerCase();
  return sensitivityProfiles[key] || sensitivityProfiles.medium;
}

const claimSchema = {
  type: "object",
  properties: {
    claim: { type: "string" }
  },
  required: ["claim"]
};
const analysisSchema = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          quote: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number" },
          explanation: { type: "string" },
          followUp: { type: "string" }
        },
        required: ["type", "quote", "severity", "confidence", "explanation", "followUp"]
      }
    }
  },
  required: ["flags"]
};
const factCheckSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["supported", "contradicted", "unclear"] },
    explanation: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" }
        },
        required: ["title", "url"]
      }
    }
  },
  required: ["verdict", "explanation", "sources"]
};
const deepgramListenParams = new URLSearchParams({
  model: "nova-3",
  interim_results: "true",
  smart_format: "true",
  punctuate: "true"
});

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": types[".json"] });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxAudioBytes) {
        reject(new Error("Audio upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function extractDeepgramTranscript(result) {
  return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";
}

export function openRouterModelId() {
  return process.env.OPENROUTER_MODEL || defaultOpenRouterModel;
}

export function deepgramListenUrl() {
  return `wss://api.deepgram.com/v1/listen?${deepgramListenParams}`;
}

export function browserbaseEnabled() {
  return Boolean(process.env.BROWSERBASE_API_KEY);
}

export function shouldSkipFactCheck(claim) {
  const text = String(claim || "").toLowerCase();
  return /moon .*made of .*cheese|earth .*flat|pigs .*fly|sky .*green|sun .*cold/.test(text);
}

async function wsDataToString(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (data?.text) return data.text();
  return String(data);
}

function sendWsFrame(socket, data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readWsFrames(buffer, onFrame) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 127;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;

    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, offset + frameLength));
    if (mask) {
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
    }

    onFrame(first & 0x0f, payload);
    offset += frameLength;
  }
  return buffer.subarray(offset);
}

export function handleUpgrade(req, socket) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname !== "/api/transcribe-stream") {
    socket.destroy();
    return;
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  const deepgram = new WebSocket(deepgramListenUrl(), {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
  });
  let opened = false;
  let pending = [];
  let input = Buffer.alloc(0);

  deepgram.addEventListener("open", () => {
    opened = true;
    pending.forEach((audio) => deepgram.send(audio));
    pending = [];
  });
  deepgram.addEventListener("message", async (event) => {
    sendWsFrame(socket, await wsDataToString(event.data));
  });
  deepgram.addEventListener("error", () => sendWsFrame(socket, JSON.stringify({ error: "Deepgram stream failed." })));
  deepgram.addEventListener("close", () => socket.end());

  socket.on("data", (chunk) => {
    input = readWsFrames(Buffer.concat([input, chunk]), (opcode, payload) => {
      if (opcode === 8) {
        if (opened) deepgram.send(JSON.stringify({ type: "CloseStream" }));
        deepgram.close();
        socket.end();
      } else if (opcode === 2 && payload.length) {
        if (opened) deepgram.send(payload);
        else pending.push(payload);
      } else if (opcode === 9) {
        sendWsFrame(socket, payload, 10);
      }
    });
  });
  socket.on("close", () => deepgram.close());
  socket.on("error", () => deepgram.close());
}

async function transcribe(req, res) {
  if (!process.env.DEEPGRAM_API_KEY) {
    json(res, 500, { error: "Set DEEPGRAM_API_KEY before using speech-to-text." });
    return;
  }

  const audio = await readBody(req);
  if (!audio.length) {
    json(res, 400, { error: "No audio received." });
    return;
  }

  const response = await fetch(`https://api.deepgram.com/v1/listen?${deepgramListenParams}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": req.headers["content-type"] || "application/octet-stream"
    },
    body: audio
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    json(res, 502, { error: result.err_msg || result.message || "Deepgram transcription failed." });
    return;
  }

  json(res, 200, { transcript: extractDeepgramTranscript(result) });
}

export function isHighSeverityIfClaim(flag, highSeverityClaimsOnly) {
  return !highSeverityClaimsOnly || flag.type !== "unsupported_claim" || flag.severity === "high";
}

export function normalizeAnalysis(value, minConfidence = 0, highSeverityClaimsOnly = false) {
  return {
    flags: Array.isArray(value?.flags)
      ? value.flags
          .filter((flag) => flag?.type && flag?.quote && (Number(flag.confidence) || 0) >= minConfidence)
          .filter((flag) => isHighSeverityIfClaim(flag, highSeverityClaimsOnly))
          .slice(0, 5)
      : []
  };
}

async function openRouterJson(messages, schema) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": `http://${host}:${port}`,
      "X-Title": "AId Hominem"
    },
    body: JSON.stringify({
      model: openRouterModelId(),
      response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
      messages
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || "OpenRouter request failed.");
  return JSON.parse(result.choices?.[0]?.message?.content || "{}");
}

async function analyze(req, res) {
  if (!process.env.OPENROUTER_API_KEY) {
    json(res, 500, { error: "Set OPENROUTER_API_KEY before using AI analysis." });
    return;
  }

  const payload = JSON.parse((await readBody(req)).toString() || "{}");
  const profile = analysisProfile(payload.sensitivity);
  const result = await openRouterJson([
    {
      role: "system",
      content: `You are a live debate coach. Flag logical fallacies and factual claims stated without evidence as unsupported_claim, even if fact-checking handles truth separately. ${profile.guidance} Set confidence (0-1) to how sure you are the flag is warranted. Use only concise flag objects.`
    },
    { role: "user", content: JSON.stringify(payload) }
  ], analysisSchema);
  json(res, 200, normalizeAnalysis(result, profile.minConfidence, Boolean(payload.highSeverityClaimsOnly)));
}

async function browserbase(path, body) {
  const response = await fetch(`https://api.browserbase.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BB-API-Key": process.env.BROWSERBASE_API_KEY
    },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Browserbase ${path} failed.`);
  return result;
}

async function factCheck(req, res) {
  if (!process.env.OPENROUTER_API_KEY) {
    json(res, 500, { error: "Set OPENROUTER_API_KEY before using fact checks." });
    return;
  }
  if (!process.env.BROWSERBASE_API_KEY) {
    json(res, 500, { error: "Set BROWSERBASE_API_KEY before using fact checks." });
    return;
  }

  const payload = JSON.parse((await readBody(req)).toString() || "{}");
  const { claim } = await openRouterJson([
    {
      role: "system",
      content: "Pick one non-obvious factual claim worth checking from the transcript. Return an empty claim for jokes, insults, common knowledge, obvious falsehoods, or trivia. Prefer claims about numbers, dates, policies, studies, laws, prices, current events, science details, or named entities."
    },
    { role: "user", content: JSON.stringify(payload) }
  ], claimSchema);
  if (!claim || shouldSkipFactCheck(claim)) {
    json(res, 200, { claim: "", verdict: "unclear", explanation: "No non-obvious claim to check.", sources: [] });
    return;
  }

  const search = await browserbase("search", { query: claim, numResults: 3 });
  const sources = (search.results || []).slice(0, 3);
  const pages = await Promise.all(sources.slice(0, 2).map(async (source) => ({
    title: source.title,
    url: source.url,
    content: String((await browserbase("fetch", {
      url: source.url,
      format: "markdown",
      allowRedirects: true
    })).content || "").slice(0, 4000)
  })));
  const verdict = await openRouterJson([
    {
      role: "system",
      content: "Fact-check using only the provided source excerpts. Return supported, contradicted, or unclear. Keep explanation under 12 words."
    },
    { role: "user", content: JSON.stringify({ claim, sources: pages }) }
  ], factCheckSchema);

  json(res, 200, { claim, ...verdict, sources: (verdict.sources?.length ? verdict.sources : sources).slice(0, 1) });
}

export function handleRequest(req, res) {
  if (req.method === "POST" && new URL(req.url, "http://localhost").pathname === "/api/transcribe") {
    transcribe(req, res).catch((error) => json(res, 500, { error: error.message }));
    return;
  }
  if (req.method === "POST" && new URL(req.url, "http://localhost").pathname === "/api/analyze") {
    analyze(req, res).catch((error) => json(res, 500, { error: error.message }));
    return;
  }
  if (req.method === "POST" && new URL(req.url, "http://localhost").pathname === "/api/fact-check") {
    factCheck(req, res).catch((error) => json(res, 500, { error: error.message }));
    return;
  }

  const cleanPath = new URL(req.url, "http://localhost").pathname === "/"
    ? "/index.html"
    : new URL(req.url, "http://localhost").pathname;
  const file = resolve(join(root, cleanPath));

  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer(handleRequest);
  server.on("upgrade", handleUpgrade);
  server.listen(port, host, () => {
    console.log(`AId Hominem running at http://${host}:${port}`);
  });
}
