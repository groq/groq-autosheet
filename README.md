# Autosheet (a GroqLabs project)

<img width="1984" height="1093" alt="autosheet-ui" src="https://github.com/user-attachments/assets/2e8e6e8e-c2bc-4127-8055-2f5a75fff3bb" />


Autosheet is a lightweight, hackable browser spreadsheet with an integrated AI copilot (chat + tools/MCP) running on Groq’s blazing-fast inference. Use it as:

- A reference implementation for GPT-OSS reasoning and function-calling on Groq
- A playground to build custom tools/functions and experiment with remote MCP servers
- A simple spreadsheet you can fork and extend

Try it online: https://autosheet.groqlabs.com/

## Quick start

Prereqs: Node 18+.

1) Install and run the web app

```bash
npm install
npm run dev
```

2) Set your Groq API key (for the proxy that forwards chat completions):

```bash
export GROQ_API_KEY=your_key_here
```

Then open the dev server URL printed in your terminal (Next.js dev). The in-browser chat will call the `/api/groq` proxy which forwards to `https://api.groq.com/openai/v1/chat/completions` and only allows approved models.

## Project layout

- `src/` – Minimal spreadsheet engine and function registry
- `web/` – Next.js app (UI: grid, chat, script editor, MCP client)
  - `web/src/app/api/groq/` – Proxy to Groq API (reads `GROQ_API_KEY`)

## Hack on it

- Add built-in spreadsheet functions in `src/lib/builtins/`
- Create new chat tools/MCP integrations in `web/src/ui/builtinTools.js`
- Adjust allowed models in `web/src/app/api/groq/allowedModels.js`

PRs welcome. This repo aims to stay small, readable, and easy to fork.

## License

Apache 2.0. See `LICENSE`.
