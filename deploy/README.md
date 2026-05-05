# Compose-based deployment (PoC)

This directory contains declarative `docker compose` deployment files.

## Design principles

1. **Build ≠ Run**: Image tag pinned in `.env`, not passed as CLI arg.
2. **Config ≠ Secrets**: Static config = bind mount; secrets = env_file.
3. **Declarative features**: `CARHER_ACP_ENABLED`/`A2A_OUTBOUND` live in compose YAML, not caller env.
4. **Idempotent**: `docker compose up -d` is safe to rerun; no hidden side effects.
5. **Rollback = change tag**: Revert a `.env` line + `up -d` = previous image, same volume data.

## Layout

```
deploy/
├── common/
│   ├── compose.template.yaml  # template used by scaffold.sh
│   └── redis.yaml             # shared redis container
├── carher-101/                # first PoC user (tested)
│   ├── compose.yaml           # service definition
│   ├── .env                   # IMAGE_TAG + overrides (git-tracked)
│   └── secrets.env            # gitignored: feishu secret, gateway token
├── carher-{102,103,104}/      # scaffolded from users.csv
├── build-and-push.sh          # build + push to registry
├── migrate-carher-101.sh      # first-time migration helper
├── init-user.sh               # first-boot steps (voice token, device pairing)
└── scaffold.sh                # generate deploy/carher-N/ from users.csv
```

## Registry-based image distribution (Phase 1 — replaces docker save|load)

### Local PoC registry
```bash
# One-time: start local registry
docker run -d --name carher-registry --restart unless-stopped \
  -p 5001:5000 -v carher-registry-data:/var/lib/registry registry:2

# Build + push
./build-and-push.sh                                    # → localhost:5001/carher-core:<date>

# Point a deploy at it
# edit deploy/carher-101/.env:
#   IMAGE_TAG=localhost:5001/carher-core:2026.4.29
docker compose up -d
```

### Production registry (ghcr.io example)
```bash
# One-time: docker login to ghcr.io (needs write:packages PAT)
echo $GH_PAT | docker login ghcr.io -u YOUR_USER --password-stdin

# Build + push
./build-and-push.sh --registry=ghcr.io/YOUR_USER

# Server side (S1/S3):
docker pull ghcr.io/YOUR_USER/carher-core:2026.4.29
# (no git clone, no docker save|load, no source on server)
```

## Usage

### Start (first time or after tag change)
```bash
cd deploy/carher-101
docker compose up -d
```

### Upgrade to new image
```bash
# Edit .env: IMAGE_TAG=carher-core:2026.4.28-new
docker compose up -d         # compose detects changed image, recreates container
# Volume carher-101-data preserved.
```

### Rollback
```bash
# Edit .env: IMAGE_TAG back to old tag
docker compose up -d
```

### Logs / stop
```bash
docker compose logs -f carher
docker compose down           # keeps volumes
```

### Important: `${VAR}` substitution in compose

Compose resolves `${VAR}` at **parse time** from shell env / `--env-file` / project `.env`,
**NOT** from `env_file:` directives. `scaffold.sh` automatically mirrors critical vars
(`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CARHER_LAN_IP`) from `docker/server.env`
into each user's `.env` so they are available at parse time.

### What legacy script still does that compose doesn't (yet)
- Voice token generation (first-boot)
- Device pairing scope repair (first-boot)
- Feishu WSClient health probe (can be done via `docker compose wait` + custom check)

For the PoC these are deferred — first-boot state already exists in volumes
for carher-101 tester. New users would need a separate init step.

### Verified deployments
- carher-101 (Mac local tester) — PoC validated 2026-04-29
- carher-199 (S1 production grayscale) — validated 2026-04-30 (OAuth fix + compose ${VAR} fix)
