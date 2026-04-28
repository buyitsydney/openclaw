# Compose-based deployment (PoC)

This directory replaces `start-user.sh` with declarative `docker compose` files.

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
│   ├── carher-net.yaml        # shared network (redis lives here)
│   └── redis.yaml             # shared redis container
├── carher-101/
│   ├── compose.yaml           # service definition (id 101)
│   ├── .env                   # image tag + per-user overrides
│   └── secrets.env            # gitignored: feishu secret, gateway token
└── carher-102/                # next user (similar)
    └── ...
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

### What start-user.sh still does that compose doesn't (yet)
- Voice token generation (first-boot)
- Device pairing scope repair (first-boot)
- Feishu WSClient health probe (can be done via `docker compose wait` + custom check)

For the PoC these are deferred — first-boot state already exists in volumes
for carher-101 tester. New users would need a separate init step.
