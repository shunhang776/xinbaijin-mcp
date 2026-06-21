# xinbaijin-mcp
Cloudflare build trigger test

## Deployment

Always deploy with:
```bash
npm run deploy
```

This runs the branch protection check before deploying. Direct `wrangler deploy` or `npx wrangler deploy` will NOT run the check.

### Required Tokens

| Variable | Purpose | Required Permission |
|---|---|---|
| `MCP_ACCESS_TOKEN` | **Required.** Authenticates ChatGPT MCP connector to the Worker. Shared secret sent as `Authorization: Bearer <token>` header. | N/A (arbitrary secret) |
| `GITHUB_TOKEN` | Runtime: read/write repo contents, create commits, submit reviews | Contents: Read and write |
| `BRANCH_PROTECTION_TOKEN` | Pre-deploy: verify branch protection rules | Administration: Read (repo) |

Set all three via `wrangler secret put`:
```bash
npx wrangler secret put MCP_ACCESS_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put BRANCH_PROTECTION_TOKEN
```

### ChatGPT MCP Connector Setup

After deployment, configure the ChatGPT MCP connector with the Worker URL, an `Authorization` header, and the `MCP_ACCESS_TOKEN` value. Without this, all `/mcp` requests return `401 Unauthorized`.

### Branch Protection Requirements

The `dev` branch on both `xinbaijin` and `xinbaijin-mcp` MUST have:
- Force pushes: disabled
- Branch deletion: disabled
- Include administrators: enabled

Without these, the TOCTOU race window described in `review-core.js` cannot be fully closed.
