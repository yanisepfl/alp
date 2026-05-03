# ALP backend — VM runbook (B7)

Deploy target: a single Linux VM (Google Cloud `e2-medium` or equivalent —
2 vCPU / 4 GB RAM is plenty). systemd is the deploy primitive; no Docker,
no k8s. TLS terminates upstream (Caddy / nginx) — the backend speaks plain
HTTP/WS on `127.0.0.1:8787` (or whatever `PORT` resolves to).

## One-time setup

```bash
# 1. Provision the VM. Ubuntu 22.04 LTS or Debian 12 work. SSH in.

# 2. Create the service account.
sudo useradd -m -s /bin/bash alp

# 3. Install Bun under the alp account.
sudo -u alp bash -c 'curl -fsSL https://bun.sh/install | bash'
# Sanity-check it landed at /home/alp/.bun/bin/bun (the systemd unit hard-codes that path).
sudo -u alp /home/alp/.bun/bin/bun --version

# 4. Clone the repo into /home/alp/alp.
sudo -u alp git clone <repo-url> /home/alp/alp

# 5. Install backend deps.
sudo -u alp bash -c 'cd /home/alp/alp/backend && bun install'

# 6. Build .env from the example.
sudo -u alp cp /home/alp/alp/backend/.env.example /home/alp/alp/backend/.env

# In .env, fill in:
#   JWT_SECRET=$(openssl rand -base64 48)
#   INGEST_SECRET=$(openssl rand -base64 48)        # same generator, different value
#   BASE_RPC_URL=https://...                        # Alchemy/QuickNode for production
#   VAULT_ADDRESS=0x...                             # ALPVault address (set after deploy)
#   ALP_DB_PATH=/var/lib/alp/alp.sqlite             # NOT the default ./data — see below
#   AUTH_DEV_BYPASS=0                               # MUST be 0 in production
#   EXPECTED_DOMAIN=<your-frontend-domain>
#   EXPECTED_URI=https://<your-frontend-domain>
#   CORS_ALLOW_ORIGIN=https://<your-frontend-domain>

# 7. Create the data directory the systemd unit's ReadWritePaths lists.
sudo mkdir -p /var/lib/alp
sudo chown alp:alp /var/lib/alp

# 8. Install the systemd unit.
sudo cp /home/alp/alp/backend/deploy/alp-backend.service /etc/systemd/system/

# 9. Start the service.
sudo systemctl daemon-reload
sudo systemctl enable --now alp-backend

# 10. Tail the journal.
sudo journalctl -fu alp-backend

# 11. Verify health.
curl http://localhost:8787/health
# expect:
# {"ok":true,"mode":"chain","lastIndexedBlock":"<bigint string|null>","ringSize":N,"connections":0,"uptimeSec":N}
```

## TLS

Don't terminate TLS in the backend. Front it with Caddy (recommended — handles
ACME/Let's Encrypt automatically) or nginx. Minimal Caddy config (don't ship
this — domain-specific):

```caddyfile
alp.example.com {
  reverse_proxy localhost:8787
}
```

That's the entire Caddyfile. `caddy run --config /etc/caddy/Caddyfile`
provisions a cert and proxies both HTTP and WS (Caddy auto-detects WS upgrades).

## Operating

| action                        | command                                              |
|-------------------------------|------------------------------------------------------|
| stop                          | `sudo systemctl stop alp-backend`                    |
| restart                       | `sudo systemctl restart alp-backend`                 |
| status                        | `sudo systemctl status alp-backend`                  |
| log tail                      | `sudo journalctl -fu alp-backend`                    |
| inspect db                    | `sudo -u alp sqlite3 /var/lib/alp/alp.sqlite`        |
| smoke (after AUTH_DEV_BYPASS=1) | `cd /home/alp/alp/backend && sudo -u alp bun run scripts/smoke.ts` |

`SIGTERM` (what `systemctl stop` sends) triggers a graceful shutdown:

1. New `/stream` and `/ingest/stream` upgrades return `503`.
2. A best-effort ping is sent to existing subscribers.
3. The sqlite db is closed (flushes WAL).
4. The process exits `0` after a 2s drain (or immediately if no connections).

`Restart=on-failure` skips exit `0`, so a clean stop doesn't loop.

## Production checklist

Before exposing the VM to the public internet:

- [ ] `JWT_SECRET` is a fresh `openssl rand -base64 48` (≥32 chars). Never reuse the example.
- [ ] `INGEST_SECRET` is a fresh `openssl rand -base64 48` (≥32 chars), distinct from `JWT_SECRET`.
- [ ] `AUTH_DEV_BYPASS=0` (or unset) — anyone reaching `/auth/dev-token` mints tokens for any wallet otherwise.
- [ ] `ALP_DB_PATH=/var/lib/alp/alp.sqlite` (not the default `./data/alp.sqlite` — that lives under the WorkingDirectory which `ProtectSystem=strict` makes read-only).
- [ ] `EXPECTED_DOMAIN` / `EXPECTED_URI` / `CORS_ALLOW_ORIGIN` match the production frontend origin exactly.
- [ ] TLS terminator (Caddy or nginx) is in front, port 8787 is firewall-blocked from the public internet.
- [ ] Cloud firewall: only 80/443 inbound from 0.0.0.0/0; SSH limited to ops IPs.
- [ ] `/ingest/*` is reachable only from the agent host — either bind it to a private network, restrict by source IP at the reverse proxy, or both.

## Backups

The sqlite file at `/var/lib/alp/alp.sqlite` is the entire state. Snapshot
the disk or `sqlite3 .backup` it on whatever cadence the demo's data-loss
budget allows. The agent ring window (last 500 messages) is the only piece
that can't be reconstructed from chain.
