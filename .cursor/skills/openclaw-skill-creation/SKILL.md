---
name: openclaw-skill-creation
description: Create or add new OpenClaw agent skills (bundled or workspace). Use when adding a new skill to the OpenClaw skills/ directory, creating SKILL.md files for the agent, or modifying skill loading/filtering logic.
---

# Adding Skills to OpenClaw

## Skill Types and Where to Put Them

| Type | Path | Scope | Use When |
|------|------|-------|----------|
| **Bundled** | `skills/<name>/SKILL.md` (source repo) | All users, all Docker containers | Skill should ship with the product |
| **Workspace** | `~/.openclaw/workspace/skills/<name>/SKILL.md` | Single user, local only | Personal/experimental skill |
| **Managed** | `~/.openclaw/skills/<name>/SKILL.md` | Single machine, shared across workspaces | Installed via `openclaw skill install` |
| **Plugin** | `extensions/<plugin>/skills/<name>/SKILL.md` | Users who enable the plugin | Skill tied to a specific plugin |

**Priority** (highest wins for same-name skill): workspace > managed > bundled > extraDirs.

**For Docker deployments**: only **bundled** skills are automatically included in the image. Workspace/managed skills require volume mounts.

## Creating a New Bundled Skill

### 1. Create the directory

```
skills/<skill-name>/
└── SKILL.md          # Required
└── references/       # Optional: docs loaded on-demand
└── scripts/          # Optional: executable helpers
```

### 2. Write SKILL.md

Frontmatter (YAML, required fields):

```yaml
---
name: my-skill
description: What this skill does. Use when <trigger conditions>. Triggers on <keywords>.
metadata: { "openclaw": { "emoji": "🔧", "requires": { "bins": ["jq"] } } }
---
```

- `name` + `description`: **Required**. Description is the primary trigger — the agent reads it to decide if the skill applies.
- `metadata.openclaw.requires.bins`: Optional. Skill hidden if listed binaries not in PATH.
- `metadata.openclaw.requires.envs`: Optional. Skill hidden if listed env vars not set.
- `metadata.openclaw.os`: Optional. Restrict to `["macos"]`, `["linux"]`, etc.

Body: Concise instructions the agent reads *after* deciding to use the skill. Keep under 500 lines. Use `references/` for large docs.

### 3. Style Guidelines

- Refer to `skills/weather/SKILL.md` (simple, shell-based) and `skills/session-logs/SKILL.md` (local file reading with jq) as good examples.
- Be concise — the context window is shared. Only include info the agent doesn't already know.
- Use imperative form ("Read the index file", not "You should read the index file").
- Include concrete shell commands or code snippets the agent can copy-paste.

## Configuration and Filtering

### allowBundled whitelist

In `openclaw.json`:

```json
{ "skills": { "allowBundled": ["weather", "github"] } }
```

- **If not set or empty**: all bundled skills are enabled (default).
- **If set**: only listed skills appear in the agent prompt.

### Per-skill toggle

```json
{ "skills": { "entries": { "my-skill": { "enabled": false } } } }
```

### Per-skill env/apiKey injection

```json
{ "skills": { "entries": { "my-skill": { "apiKey": "sk-xxx", "env": { "FOO": "bar" } } } } }
```

Injected at agent run start, restored after run ends.

## How Skills Reach the Agent

```
loadSkillEntries()          — src/agents/skills/workspace.ts
  scan all skill dirs, parse SKILL.md frontmatter
    ↓
shouldIncludeSkill()        — src/agents/skills/config.ts
  filter by enabled, allowBundled, OS, bins, envs
    ↓
buildWorkspaceSkillsPrompt() — src/agents/skills/workspace.ts
  format as XML <available_skills> list
    ↓
buildSkillsSection()        — src/agents/system-prompt.ts
  inject into agent system prompt as "## Skills (mandatory)"
```

The agent sees skill names + descriptions. When a skill matches, it reads the full SKILL.md via the `read` tool, then follows instructions.

## Checklist

- [ ] `SKILL.md` has `name` and `description` in frontmatter
- [ ] Description includes trigger conditions and keywords
- [ ] Body is concise, imperative, with concrete examples
- [ ] No `README.md` or other auxiliary files — only SKILL.md + resources
- [ ] Tested: restart gateway, verify skill appears in agent's skill list
