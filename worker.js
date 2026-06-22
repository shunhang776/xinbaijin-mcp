import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./oauth/github-handler.ts";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { REPOSITORIES, DEFAULT_REPOSITORY, submitReview, getRepositoryConfig, githubHeaders } from "./review-core.js";

import { REPOSITORY_PARAM, GET_LATEST_HANDOFF_SCHEMA, GET_PATCH_SCHEMA, SUBMIT_REVIEW_SCHEMA, GET_FILE_CONTENT_SCHEMA } from "./mcp-schemas.js";
export { REPOSITORY_PARAM, GET_LATEST_HANDOFF_SCHEMA, GET_PATCH_SCHEMA, SUBMIT_REVIEW_SCHEMA, GET_FILE_CONTENT_SCHEMA };

  const mcpApiHandler = {
  async fetch(request, env, ctx) {
    const server = createServer(env);

    return createMcpHandler(server, {
      route: "/mcp"
    })(request, env, ctx);
  }
};

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 浏览器健康检查
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "xinbaijin-mcp",
        role: "gateway-and-mcp",
        status: "running",
        mcp_endpoint: "/mcp",
        authentication: "oauth"
      });
    }

    // 保留现有 GitHub Webhook
    if (
      request.method === "POST" &&
      (url.pathname === "/" || url.pathname === "/webhook")
    ) {
      return handleWebhook(request);
    }

    // /mcp、/authorize、/callback、/token、/register 交给 OAuthProvider
    return oauthProvider.fetch(request, env, ctx);
  }
};

export function createServer(env) {
  const server = new McpServer(
  {
    name: "xinbaijin-mcp",
    version: "1.0.0"
  },
  {
    instructions:
      "get_latest_handoff、get_patch 和 get_file_content 是只读工具，" +
      "只读取允许列表中的 GitHub 仓库，不修改任何文件。" +
      "submit_review 是唯一写入工具，只能写入目标仓库根目录的 review.json。"
  }
);

  server.registerTool(
    "get_latest_handoff",
    {
      title: "Get latest repository handoff",
      description:
        "读取目标仓库（必填）dev 分支的最新提交，并生成标准化 handoff。",
      inputSchema: GET_LATEST_HANDOFF_SCHEMA,
      annotations: {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false
}
    },
    async ({ repository }) => {
      if (!repository) {
        throw new Error("repository is required. Choose xinbaijin or xinbaijin-mcp.");
      }
      try {
        const handoff = await getLatestHandoff(env, repository);

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
      title: "Get commit metadata",
      description:
        "只读操作。读取指定提交的元数据、父提交和全部修改文件列表，" +
        "不返回原始 patch 内容。审查具体修改时，应使用 get_file_content " +
        "分别读取 base_commit 与 commit 对应的文件内容。",
      inputSchema: GET_PATCH_SCHEMA,
      outputSchema: {
        protocol: z.literal("xinbaijin-patch/2.0"),
        repository: z.string(),
        branch: z.string(),
        requested_ref: z.string(),
        commit: z.string(),
        base_commit: z.string().nullable(),
        message: z.string().nullable(),
        stats: z.object({
          additions: z.number(),
          deletions: z.number(),
          total: z.number()
        }),
        files: z.array(
          z.object({
            filename: z.string(),
            previous_filename: z.string().nullable(),
            status: z.string().nullable(),
            additions: z.number(),
            deletions: z.number(),
            changes: z.number()
          })
        )
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ sha, repository }) => {
      if (!repository) {
        throw new Error(
          "repository is required. Choose xinbaijin or xinbaijin-mcp."
        );
      }

      try {
        const patch = await getPatch(env, sha, repository);

        return {
          structuredContent: patch,
          content: [
            {
              type: "text",
              text:
                `已获取提交 ${patch.commit} 的元数据，` +
                `父提交 ${patch.base_commit ?? "无"}，` +
                `共 ${patch.files.length} 个修改文件，` +
                `新增 ${patch.stats.additions} 行，` +
                `删除 ${patch.stats.deletions} 行。`
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

  server.registerTool(
    "submit_review",
    {
      title: "Submit code review",

    description:
  "写入操作。只允许将代码审查结果写入所选允许仓库 dev 分支根目录的 review.json，" +
  "不能修改其他源码文件。执行前应获得用户许可。",
      inputSchema: SUBMIT_REVIEW_SCHEMA,
      annotations: {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true
},
    },
    async ({ repository, ...input }) => {
      if (!repository) {
        throw new Error("repository is required. Choose xinbaijin or xinbaijin-mcp.");
      }
      try {
        const result = await submitReview(env, input, repository);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
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
  server.registerTool(
    "get_file_content",
    {
      title: "Read repository file",
      description:
        "读取指定 Git 提交中的原始 UTF-8 文件内容，并返回 SHA-256、字节长度、行尾类型等校验信息。" +
        "当审查涉及转义符、引号、Unicode、Base64、JSON 格式、文件末尾换行或编码时，" +
        "必须调用此工具核实原始文件后才能形成 finding。",

      inputSchema: GET_FILE_CONTENT_SCHEMA,

      outputSchema: {
        protocol: z.literal("xinbaijin-file/1.0"),
        repository: z.string(),
        ref: z.string(),
        path: z.string(),
        encoding: z.literal("utf-8"),
        github_blob_sha: z.string(),
        sha256: z.string(),
        byte_length: z.number().int().nonnegative(),
        has_trailing_newline: z.boolean(),
        line_ending: z.enum([
          "lf",
          "crlf",
          "cr",
          "mixed",
          "none"
        ]),
        content: z.string()
      },

    annotations: {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false
}
    },

    async ({ path, ref, repository }) => {
      if (!repository) {
        throw new Error("repository is required. Choose xinbaijin or xinbaijin-mcp.");
      }
      try {
        const result = await getFileContent(env, path, ref, repository);

        return {
          structuredContent: result,

          // 这里直接返回原始源码，不再 JSON.stringify 整个对象
          content: [
            {
              type: "text",
              text:
                `文件：${result.path}\n` +
                `提交：${result.ref}\n` +
                `SHA-256：${result.sha256}\n` +
                `字节数：${result.byte_length}\n` +
                `行尾：${result.line_ending}\n` +
                `文件末尾换行：${result.has_trailing_newline}\n\n` +
                "===== RAW FILE CONTENT =====\n" +
                result.content +
                "\n===== END RAW FILE CONTENT ====="
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

async function getLatestHandoff(env, repositoryName) {
  const { owner, repo, branch, token } = getRepositoryConfig(env, repositoryName);

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

async function getPatch(
  env,
  requestedSha,
  repositoryName
) {
  const {
    owner,
    repo,
    branch,
    token
  } = getRepositoryConfig(env, repositoryName);

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
    `https://api.github.com/repos/${owner}/${repo}/commits/` +
    encodeURIComponent(ref);

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

  const parents = Array.isArray(commit.parents)
    ? commit.parents
    : [];

  return {
    protocol: "xinbaijin-patch/2.0",
    repository: `${owner}/${repo}`,
    branch,
    requested_ref: ref,
    commit: commit.sha || null,
    base_commit:
      parents.length > 0 && typeof parents[0]?.sha === "string"
        ? parents[0].sha
        : null,
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
      changes: file.changes ?? 0
    }))
  };
}

function normalizeRepositoryPath(inputPath) {
  const normalized = inputPath
    .trim()
    .replace(/\\/g, "/");

  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\0")
  ) {
    throw new Error(
      "Invalid repository path."
    );
  }

  const segments = normalized.split("/");

  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    throw new Error(
      "Repository path cannot contain empty, dot, or parent segments."
    );
  }

  return segments.join("/");
}

function encodeRepositoryPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

function detectLineEnding(text) {
  const crlfCount =
    (text.match(/\r\n/g) || []).length;

  const withoutCrLf =
    text.replace(/\r\n/g, "");

  const lfCount =
    (withoutCrLf.match(/\n/g) || []).length;

  const crCount =
    (withoutCrLf.match(/\r/g) || []).length;

  const detectedTypes = [
    crlfCount > 0 ? "crlf" : null,
    lfCount > 0 ? "lf" : null,
    crCount > 0 ? "cr" : null
  ].filter(Boolean);

  if (detectedTypes.length === 0) {
    return "none";
  }

  if (detectedTypes.length > 1) {
    return "mixed";
  }

  return detectedTypes[0];
}

async function getFileContent(
  env,
  requestedPath,
  ref,
  repositoryName
) {
  const {
    owner,
    repo,
    token
  } = getRepositoryConfig(env, repositoryName);

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  const path =
    normalizeRepositoryPath(requestedPath);

  const encodedPath =
    encodeRepositoryPath(path);

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/contents/${encodedPath}` +
    `?ref=${encodeURIComponent(ref)}`;

  const response = await fetch(endpoint, {
    headers: githubHeaders(token)
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Unable to read repository file: ` +
      `${response.status} ${details}`
    );
  }

  const file = await response.json();

  if (
    Array.isArray(file) ||
    file.type !== "file"
  ) {
    throw new Error(
      `${path} is not a normal repository file.`
    );
  }

  if (
    file.encoding !== "base64" ||
    typeof file.content !== "string"
  ) {
    throw new Error(
      `GitHub did not return Base64 file content for ${path}.`
    );
  }

  // GitHub 的 Base64 内容中可能包含换行
  const cleanBase64 =
    file.content.replace(/\s/g, "");

  const bytes =
    Buffer.from(cleanBase64, "base64");

  // 防止一次把过大的文件塞入 ChatGPT 上下文
  const MAX_FILE_BYTES = 500_000;

  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large: ${bytes.byteLength} bytes. ` +
      `Maximum allowed size is ${MAX_FILE_BYTES} bytes.`
    );
  }

  let decodedContent;

  try {
    decodedContent =
      new TextDecoder("utf-8", {
        fatal: true
      }).decode(bytes);
  } catch {
    throw new Error(
      `${path} is not valid UTF-8 text.`
    );
  }

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  const sha256 =
    bytesToHex(new Uint8Array(digest));

  const lastByte =
    bytes.byteLength > 0
      ? bytes[bytes.byteLength - 1]
      : null;

  return {
    protocol: "xinbaijin-file/1.0",
    repository: `${owner}/${repo}`,
    ref,
    path,
    encoding: "utf-8",

    // GitHub 自己的 Blob SHA
    github_blob_sha:
      file.sha || "",

    // 实际文件字节的 SHA-256
    sha256,

    byte_length:
      bytes.byteLength,

    has_trailing_newline:
      lastByte === 0x0a ||
      lastByte === 0x0d,

    line_ending:
      detectLineEnding(decodedContent),

    content:
      decodedContent
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


