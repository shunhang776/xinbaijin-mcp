/**
 * diagnostics.js — Safe GitHub API logging utility.
 *
 * SAFE TO LOG:
 *   - tool             (e.g. "get_latest_handoff")
 *   - repository       (e.g. "xinbaijin-mcp")
 *   - owner            (GitHub org or user)
 *   - repo             (repository name)
 *   - ref              (branch name or full commit SHA)
 *   - status           (HTTP status code)
 *   - githubMessage    (response JSON .message — GitHub's own error string)
 *   - requestId        (x-github-request-id response header)
 *   - errorName        (error.constructor.name, e.g. "HttpError")
 *   - errorMessage     (error.message)
 *
 * NEVER LOGGED:
 *   - tokens, Authorization header values, Bearer strings
 *   - full request headers (including User-Agent customizations that may leak env)
 *   - environment variables of any kind
 *   - secrets, credentials, API keys
 *   - request body payloads (may contain secrets)
 *   - response body beyond GitHub's own .message string
 *   - file system paths
 */

/**
 * Log a structured GitHub API error to stderr as a single-line JSON string.
 *
 * @param {Object} details
 * @param {string}  details.tool          — MCP tool name (e.g. "get_latest_handoff")
 * @param {string}  details.repository    — logical repo key (e.g. "xinbaijin-mcp")
 * @param {string}  details.owner         — GitHub owner/org
 * @param {string}  details.repo          — GitHub repo name
 * @param {string}  details.ref           — branch or commit SHA
 * @param {number}  details.status        — HTTP status code
 * @param {string}  details.githubMessage — GitHub response .message
 * @param {string}  details.requestId     — x-github-request-id header
 * @param {string}  details.errorName     — error.constructor.name
 * @param {string}  details.errorMessage  — error.message
 */
function logGitHubError(details) {
  const allowed = {
    tool: details.tool,
    repository: details.repository,
    owner: details.owner,
    repo: details.repo,
    ref: details.ref,
    status: details.status,
    githubMessage: details.githubMessage,
    requestId: details.requestId,
    errorName: details.errorName,
    errorMessage: details.errorMessage
  };

  // Strip any fields that are undefined so the JSON stays lean.
  for (const key of Object.keys(allowed)) {
    if (allowed[key] === undefined) {
      delete allowed[key];
    }
  }

  const line = JSON.stringify(allowed);
  console.error(line);
}

export { logGitHubError };
