# AI Hominem

A live debate coach that transcribes speech, flags logical fallacies, and fact-checks claims in real time.

## Setup

Copy `.env.example` to `.env` and fill in your keys:

| Variable | Purpose |
|---|---|
| `DEEPGRAM_API_KEY` | Streaming speech-to-text |
| `OPENROUTER_API_KEY` | Fallacy analysis and fact-checking |
| `OPENROUTER_MODEL` | Model override (default: `google/gemini-3.1-flash-lite`) |
| `BROWSERBASE_API_KEY` | Web search for fact-checking |

## Run

```sh
npm start
```

Open `http://localhost:4173`. Use **Start** for live Deepgram streaming or **Demo** for a canned debate.

## Desktop app (Electron)

```sh
npm install
npm run desktop
```

Use **Mic** for microphone input or **Desktop** for system audio. macOS will prompt for microphone, screen, and system-audio permissions. Closing the window hides the app to the tray; **Quit** from the tray menu exits.
