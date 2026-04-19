# ClaudePaw Plugins

Plugins extend agent capabilities with additional prompts and context. Each plugin is a directory under `plugins/` containing two files.

## Plugin Format

```
plugins/
  my-plugin/
    manifest.json    # metadata and config
    prompt.md        # the prompt/instructions injected into the agent
```

### manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "What this plugin does",
  "keywords": ["search", "terms"],
  "agent_id": "builder",
  "dependencies": ["other-plugin-id"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique kebab-case identifier. Must match directory name. |
| `name` | yes | Display name shown in dashboard and /plugins command. |
| `version` | yes | Semver version string. |
| `author` | yes | Who wrote the plugin. |
| `description` | yes | One-line summary of what the plugin does. |
| `keywords` | no | Array of strings for discovery/search. Default: [] |
| `agent_id` | no | Which agent this plugin extends. Omit for global plugins. |
| `dependencies` | no | Array of other plugin IDs this depends on. Default: [] |

### prompt.md

Markdown file with the prompt content that gets injected into the agent's context when the plugin is active. Write it as instructions the agent should follow.

## How Plugins Work

1. At startup, `src/plugins/loader.ts` scans every subdirectory of `plugins/`
2. Each directory must have a `manifest.json` (prompt.md is optional but recommended)
3. Valid plugins are registered in the in-memory registry
4. Agents can query `getPluginsForAgent(agentId)` to get their active plugins
5. The dashboard shows all plugins with enable/disable toggles
6. The `/plugins` Telegram command lists installed plugins

## Example Plugin

See `example-greeter/` for a minimal working example:

```
plugins/example-greeter/
  manifest.json   # targets the "builder" agent
  prompt.md       # greeting instructions
```

## Managing Plugins

- **Install**: Drop a directory with manifest.json + prompt.md into `plugins/`
- **Enable/Disable**: Use the dashboard Plugins page or PATCH `/api/v1/plugins/:id`
- **List**: Send `/plugins` in Telegram or visit the dashboard
- **Remove**: Delete the plugin directory (requires restart)
