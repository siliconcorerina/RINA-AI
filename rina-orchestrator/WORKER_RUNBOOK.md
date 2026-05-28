# rina-orchestrator-serve — Worker setup runbook

End-to-end recipe to swap rina-mobile's "Tâche" mock for a **real
Playwright drive** running on your laptop, tunnelled to the Vercel
backend. ~10 minutes the first time.

## Prerequisites (one-time)

- Node.js 18+ (you already have it).
- `cloudflared` CLI for the public tunnel. Install on Windows via
  winget:

  ```powershell
  winget install --id Cloudflare.cloudflared
  ```

  Verify: `cloudflared --version`. Free tier, no signup needed for
  quick-tunnels.

## Setup

### 1. Install Chromium for Playwright (already done if you've worked on rina-orchestrator)

```powershell
cd C:\Users\coolb\OneDrive\Desktop\RINA-AI\rina-orchestrator
npx playwright install chromium
```

### 2. Pick a worker token (any random string)

This is the shared secret between Vercel `/api/agent` and your worker.
A simple `openssl rand -hex 16` or just a random 32-char string works.

Example: `8f2b1c5e9d7a3a4f6c2e8b9d1a5c7f3e`

### 3. Start the worker

```powershell
cd C:\Users\coolb\OneDrive\Desktop\RINA-AI\rina-orchestrator

# Required env. Backend is the LLM that powers planning + browser
# decisions inside the agent loop.
$env:DEEPSEEK_API_KEY = "sk-9003fdb9731b46ae95c1dae4abcf9e6e"

# Shared secret with Vercel.
$env:ORCHESTRATOR_WORKER_TOKEN = "8f2b1c5e9d7a3a4f6c2e8b9d1a5c7f3e"

# Optional knobs (sensible defaults):
# $env:PORT = "8787"
# $env:BACKEND = "deepseek:deepseek-chat"
# $env:HEADLESS = "true"       # set "false" to see Chromium drive live
# $env:MAX_STEPS = "6"

node out\server.js
```

You should see:

```
🤖 rina-orchestrator-serve v0.1.0 listening on http://localhost:8787
   backend: deepseek:deepseek-chat
   headless: true
   maxSteps: 6
   auth: Bearer token required
```

Smoke test in a second PowerShell window:

```powershell
curl http://localhost:8787/health
# → {"ok":true,"version":"0.1.0"}
```

### 4. Expose the worker via Cloudflare quick-tunnel

In a **third** PowerShell window:

```powershell
cloudflared tunnel --url http://localhost:8787
```

You'll see something like:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://something-random-words.trycloudflare.com                                          |
+--------------------------------------------------------------------------------------------+
```

Copy that **HTTPS URL** — that's your worker's public endpoint.

Verify it works:

```powershell
curl https://something-random-words.trycloudflare.com/health
# → {"ok":true,"version":"0.1.0"}
```

### 5. Wire Vercel to your worker

Two env vars to add on the **rina-ai-pro** Vercel project at
https://vercel.com/coolbovo-6731s-projects/rina-ai-pro/settings/environment-variables:

| Key                          | Value                                              | Targets        |
|------------------------------|----------------------------------------------------|----------------|
| `ORCHESTRATOR_WORKER_URL`    | The cloudflared HTTPS URL (no trailing slash)      | Production     |
| `ORCHESTRATOR_WORKER_TOKEN`  | The same token you set in step 2                   | Production     |

Hit **Redeploy** on the latest deployment so the new env vars are
picked up.

### 6. Test from the app

1. Open https://app.plateforme-rina.com
2. Toggle **Tâche** ON
3. Type a real browser-able goal:
   - "Va sur https://news.ycombinator.com et donne-moi les 3 premiers titres"
   - "Trouve le prix actuel du Bitcoin sur https://www.coingecko.com"
4. Hit send

You should see the worker's Chromium fire up (logs in the worker
window), each step's real progress messages stream in, and a real
final answer.

## Daily use

After the one-time setup, the loop is:

```powershell
# Window 1: worker
cd C:\Users\coolb\OneDrive\Desktop\RINA-AI\rina-orchestrator
$env:DEEPSEEK_API_KEY = "sk-…"
$env:ORCHESTRATOR_WORKER_TOKEN = "…"
node out\server.js

# Window 2: tunnel
cloudflared tunnel --url http://localhost:8787
# Copy the URL → update ORCHESTRATOR_WORKER_URL on Vercel → redeploy
```

The cloudflared quick-tunnel URL CHANGES every time you restart it.
For a stable URL, follow the Cloudflare Tunnel "named tunnel" guide
(requires a free Cloudflare account + a registered domain — you
already have plateforme-rina.com on Cloudflare, so you could point
`agent.plateforme-rina.com` at your laptop). Out of scope here.

## When to graduate to a hosted worker

Local + tunnel is fine for development + demo. For production:

- **Fly.io** — `flyctl launch` with a Dockerfile that bundles Node +
  Chromium. ~$5/month. Recommended next step.
- **Hetzner Cloud** — $4/month for a CPX11. Need to install Node +
  Chromium + a process manager (systemd or pm2).
- **Railway** — easy, ~$5-10/month. Good for low traffic.
- **Browserbase** — hosted browser sessions. Worker stays on
  Vercel/Fly but offloads Chromium. Most scalable, paid above the
  free 60-min/month tier.

The worker's code doesn't change between local and hosted — only the
`ORCHESTRATOR_WORKER_URL` env on Vercel.

## Troubleshooting

### "Failed to fetch" in the mobile app
- Is the worker running? `curl http://localhost:8787/health` should
  return `{ok:true}`.
- Is the tunnel up? `curl https://your-tunnel.trycloudflare.com/health`
  should return the same.
- Is `ORCHESTRATOR_WORKER_URL` set on Vercel **and** redeployed?

### `401 Unauthorized` from the worker
- `ORCHESTRATOR_WORKER_TOKEN` doesn't match on the two sides. Re-
  paste it on Vercel.

### Chromium fails to launch with a "missing dependencies" error
- On Linux/Docker only. `npx playwright install --with-deps chromium`.

### Steps time out
- `headless: false` to watch what's happening in real time. The
  agent is probably stuck on a cookie banner or a captcha — both
  expected at v0.1; the agent's system prompt handles cookie banners
  but captchas are out of scope.

### The browser opens but Google blocks it
- Headless Chromium is identified as a bot. Use `HEADLESS=false` for
  testing on Google. For production, the Fly.io / Browserbase path
  has better fingerprinting.
