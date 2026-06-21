# AI Hominem

Dependency-free MVP for the live debate coach spec.

```sh
export DEEPGRAM_API_KEY=...
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=google/gemini-3.1-flash-lite
export BROWSERBASE_API_KEY=...
node server.js
```

Open `http://localhost:4173`, then use `Start` for streaming Deepgram Nova-3 speech-to-text or `Demo` for the canned AI-in-education debate.

Standalone app:

```sh
npm install
npm run desktop
```

Use `Mic` for microphone analysis or `Desktop` for system/screen audio. macOS may ask for microphone, screen, and system-audio permissions. Closing the app window hides it to the tray; `Quit` in the tray menu stops background listening.

Skipped: SDK dependency. Add only if the hand-rolled proxy becomes annoying.
