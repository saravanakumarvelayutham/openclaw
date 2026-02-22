# Ollama Auth Proxy (Docker)

This adds a token-protected HTTP proxy in front of your Ollama API so other OpenClaw users can call it safely.

## 1) Configure

```bash
cd ops/ollama-auth-proxy
cp .env.example .env
```

Set a strong random token in `.env`:

```bash
OLLAMA_PROXY_TOKEN=...
```

## 2) Start

```bash
docker compose up -d
```

The compose file binds to `127.0.0.1` only, so it is not exposed on LAN/public interfaces.

## 3) Verify

Without token (should be `401`):

```bash
curl -i http://localhost:11435/api/tags
```

With token (should be `200` + JSON if upstream is reachable):

```bash
curl -i \
  -H "Authorization: Bearer $OLLAMA_PROXY_TOKEN" \
  http://localhost:11435/api/tags
```

## 4) Expose privately via Tailscale (recommended)

Install and sign in on this host:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then publish the local proxy to your tailnet:

```bash
sudo tailscale serve --bg 11435
tailscale serve status
```

Other users on your tailnet can connect using the HTTPS URL shown by `tailscale serve status` (typically `https://<device>.<tailnet>.ts.net`).

## 5) Configure the other user's OpenClaw

They can use this provider block in their `~/.openclaw/openclaw.json`:

```json5
{
  models: {
    providers: {
      shared-ollama: {
        api: "ollama",
        baseUrl: "https://YOUR_DEVICE.YOUR_TAILNET.ts.net",
        apiKey: "SAME_TOKEN_FROM_OLLAMA_PROXY_TOKEN",
        models: [{ id: "huihui_ai/huihui-moe-abliterated:12b" }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "shared-ollama/huihui_ai/huihui-moe-abliterated:12b" },
      models: { "shared-ollama/huihui_ai/huihui-moe-abliterated:12b": {} },
    },
  },
}
```

## Security notes

- This proxy enforces bearer-token auth only. Put TLS in front if exposed on the public Internet.
- Prefer network restriction (VPN/Tailscale/firewall allowlist) in addition to token auth.
- Rotate `OLLAMA_PROXY_TOKEN` if leaked.
