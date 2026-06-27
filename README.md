# xinbaijin-mcp
Cloudflare build trigger test

## Deployment

Always deploy with:
```bash
npm run deploy
```

This runs the branch protection check before deploying. Direct `wrangler deploy` or `npx wrangler deploy` will NOT run the check.

### Worker Runtime Secrets

Set via `npx wrangler secret put` (available as `env.*` in the Worker):

| Variable | Purpose | Permission |
|---|---|---|
| `MCP_ACCESS_TOKEN` | Authenticates ChatGPT MCP connector | Arbitrary secret |
| `GITHUB_TOKEN` | Runtime: read/write repo contents, create commits, create PRs | Contents: Read and write, Pull requests: Read and write |

```bash
npx wrangler secret put MCP_ACCESS_TOKEN
npx wrangler secret put GITHUB_TOKEN
```

### Pre-Deploy Environment Variable

Set in your local shell, CI, or Cloudflare Builds environment (read by `scripts/check-branch-protection.js` via `process.env`). Falls back to `GITHUB_TOKEN` if not set.

| Variable | Purpose | Permission |
|---|---|---|
| `BRANCH_PROTECTION_TOKEN` | Pre-deploy: verify branch protection rules | Administration: Read |

```bash
# Local shell
export BRANCH_PROTECTION_TOKEN=github_pat_...

# CI / Cloudflare Builds: configure as a build secret/environment variable
```

### ChatGPT MCP Connector Setup

After deployment, configure the ChatGPT MCP connector with the Worker URL and header `Authorization: Bearer <MCP_ACCESS_TOKEN>`. Without this, all `/mcp` requests return `401 Unauthorized`.

### Branch Protection Requirements

The `dev` branch on both `xinbaijin` and `xinbaijin-mcp` MUST have:
- Force pushes: disabled
- Branch deletion: disabled
- Include administrators: enabled

Without these, the TOCTOU race window described in `review-core.js` cannot be fully closed.
