# Telegram Mini App relay

This folder is the Vercel app. It checks Telegram Mini App `initData`, allows one Telegram user, and forwards a fixed set of recorder actions to the Windows PC. It does not run FFmpeg, keep a capture loop, or store audio.

The Windows recorder in `backend/` still does that work. Vercel reaches it through a named Cloudflare Tunnel at `RECORDER_ORIGIN`, and proves the call with `X-Recorder-Relay-Key`.

## Vercel environment

Add these as Sensitive values for Production and Preview. Use the same relay key and BotFather token as `backend/.env`. Do not put them in `VITE_*` or `NEXT_PUBLIC_*` variables, client code, Git, or chat.

```text
RECORDER_ORIGIN=https://recorder.example.com
RECORDER_RELAY_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=5567866089
```

Generate the relay key on the recorder PC and copy it into both places:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

Set the Vercel project root directory to `mini-app-relay`.

## Routes

| Mini App | Windows recorder |
|---|---|
| `POST /api/relay/record` | resolve the Space, then start the recording |
| `POST /api/relay/monitor` | watch until the Space can be recorded |
| `GET /api/relay/monitor?id=` | monitor status |
| `GET /api/relay/status?id=` | recording status |
| `POST /api/relay/stop` | stop and save |
| `GET /api/relay/archive` | saved recordings |
| `DELETE /api/relay/archive?id=` | delete one recording |
| `GET /api/relay/clips` | clip library |
| `POST /api/relay/clips` | cut a clip |
| `GET /api/health` | relay process is up |

The browser sends `Authorization: tma <initData>`. The relay key is added on the server. Playback URLs in the JSON point at the recorder hostname so the phone can open audio directly.

## Cloudflare Tunnel

On the recorder PC, after `cloudflared tunnel login`:

```powershell
cloudflared tunnel create x-space-recorder
cloudflared tunnel route dns x-space-recorder recorder.example.com
```

Use a hostname on a domain Cloudflare already manages. Copy `scripts/windows/cloudflared.config.example.yml` to `%USERPROFILE%\.cloudflared\config.yml` and fill in the tunnel id. Then either:

```powershell
cloudflared tunnel run x-space-recorder
```

or install it as a service with `cloudflared service install`. Put the hostname in `TELEGRAM_PUBLIC_BASE_URL` and `RECORDER_ORIGIN`.

From a phone on mobile data, `https://recorder.example.com/api/space/archive` should return a JSON list. Recording, stop, delete, and account routes on that hostname reject callers that do not come through this relay.

## BotFather

After Vercel gives the Mini App a stable `https://` URL:

1. Open BotFather and send `/mybots`.
2. Choose `@EmpMfer_bot`, then Bot Settings, then Menu Button.
3. Set the button text to `Open Recorder`.
4. Set the URL to the Vercel Mini App URL.

## Checks

```bash
cd mini-app-relay
npm test
```
