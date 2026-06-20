
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_OWNER = "shunhang776";
const DEFAULT_REPO = "xinbaijin-mcp";
const DEFAULT_BRANCH = "dev";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ChatGPT MCP 连接入口
    if (url.pathname === "/mcp") {
      const server = createServer(env);

      return createMcpHandler(server, {
        route: "/mcp"
      })(request, env, ctx);
    }

    // 浏览器健康检查
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "xinbaijin-mcp",
        role: "gateway-and-mcp",
        status: "running",
        mcp_endpoint: "/mcp"
      });
    }

    // GitHub Webhook 入口
    if (
      request.method === "POST" &&
      (url.pathname === "/" || url.pathname === "/webhook")
    ) {
      return handleWebhook(request);
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "Method not allowed" },
        405
      );
    }

    return jsonResponse(
      { ok: false, error: "Not found" },
      404
    );
  }
};

function createServer(env) {
  const server = new McpServer({
    name: "xinbaijin-mcp",
    version: "1.0.0"
  });

  server.registerTool(
    "get_latest_handoff",
    {
      description:
        "读取 xinbaijin-mcp 仓库 dev 分支的最新提交，并生成标准化 handoff。",
      inputSchema: {}
    },
    async () => {
      try {
        const handoff = await getLatestHandoff(env);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(handoff, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : String(error)
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "get_patch",
    {
      description:
        "读取指定提交（默认 dev 最新提交）的文件级 patch，供 ChatGPT 进行代码审查。",
      inputSchema: z.object({
        sha: z
          .string()
          .trim()
          .min(7)
          .optional()
          .describe("可选提交 SHA；省略时读取 dev 分支最新提交。")
      })
    },
    async ({ sha }) => {
      try {
        const patch = await getPatch(env, sha);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(patch, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : String(error)
            }
          ]
        };
      }
    }
  );
  return server;
}

async function getLatestHandoff(env) {
  const owner = env.GITHUB_OWNER || DEFAULT_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const token = env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`;

  const response = await fetch(endpoint, {
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "user-agent": "xinbaijin-mcp-worker",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `GitHub API request failed: ${response.status} ${details}`
    );
  }

  const commit = await response.json();
  const files = Array.isArray(commit.files) ? commit.files : [];

  return {
    protocol: "xinbaijin-handoff/1.0",
    event: "code_changed",
    repository: `${owner}/${repo}`,
    branch,
    commit: commit.sha || null,
    message: commit.commit?.message || null,
    author:
      commit.author?.login ||
      commit.commit?.author?.name ||
      null,
    changed_files: {
      added: files
        .filter((file) => file.status === "added")
        .map((file) => file.filename),
      modified: files
        .filter((file) =>
          ["modified", "renamed", "changed", "copied"].includes(file.status)
        )
        .map((file) => file.filename),
      removed: files
        .filter((file) => file.status === "removed")
        .map((file) => file.filename)
    },
    status: "ready_for_review"
  };
}

async function getPatch(env, requestedSha) {
  const owner = env.GITHUB_OWNER || DEFAULT_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const token = env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  const ref =
    typeof requestedSha === "string" && requestedSha.trim()
      ? requestedSha.trim()
      : branch;

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "xinbaijin-mcp-worker",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `GitHub API request failed: ${response.status} ${details}`
    );
  }

  const commit = await response.json();
  const files = Array.isArray(commit.files)
    ? commit.files
    : [];

  return {
    protocol: "xinbaijin-patch/1.0",
    repository: `${owner}/${repo}`,
    branch,
    requested_ref: ref,
    commit: commit.sha || null,
    message: commit.commit?.message || null,
    stats: {
      additions: commit.stats?.additions ?? 0,
      deletions: commit.stats?.deletions ?? 0,
      total: commit.stats?.total ?? 0
    },
    files: files.map((file) => ({
      filename: file.filename,
      previous_filename: file.previous_filename || null,
      status: file.status || null,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      patch_available: typeof file.patch === "string",
      patch:
        typeof file.patch === "string"
          ? file.patch
          : null
    }))
  };
}

async function handleWebhook(request) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body" },
      400
    );
  }

  const githubEvent =
    request.headers.get("X-GitHub-Event") || "unknown";

  const ref = body.ref || "";
  const branch = ref.startsWith("refs/heads/")
    ? ref.substring("refs/heads/".length)
    : null;

  const commits = Array.isArray(body.commits)
    ? body.commits
    : [];

  const latestCommit =
    body.head_commit ||
    commits[commits.length - 1] ||
    null;

  const handoff = {
    protocol: "xinbaijin-handoff/1.0",
    event: githubEvent,
    repository: body.repository?.full_name || null,
    branch,
    commit: body.after || latestCommit?.id || null,
    message: latestCommit?.message || null,
    author:
      latestCommit?.author?.username ||
      latestCommit?.author?.name ||
      null,
    changed_files: {
      added: latestCommit?.added || [],
      modified: latestCommit?.modified || [],
      removed: latestCommit?.removed || []
    },
    status: "ready_for_review"
  };

  return jsonResponse({
    ok: true,
    handoff
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
