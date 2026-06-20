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
| `GITHUB_TOKEN` | Runtime: read/write repo contents, create commits | Contents: Read and write |
| `BRANCH_PROTECTION_TOKEN` | Pre-deploy: verify branch protection rules | Administration: Read (repo) |

`BRANCH_PROTECTION_TOKEN` can be the same token as `GITHUB_TOKEN` if it has Administration: Read permission. For least-privilege, use separate tokens.

### Branch Protection Requirements

The `dev` branch on both `xinbaijin` and `xinbaijin-mcp` MUST have:
- Force pushes: disabled
- Branch deletion: disabled
- Include administrators: enabled

Without these, the TOCTOU race window described in `review-core.js` cannot be fully closed.
