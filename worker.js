
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Buffer } from "node:buffer";

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
  "读取指定提交的文件级 patch，供 ChatGPT 进行代码审查。" +
  "涉及转义符、引号、Unicode、Base64、JSON 格式、" +
  "文件末尾换行或编码问题时，不得仅根据 patch 下结论，" +
  "必须调用 get_file_content 核实原始源码。",
  inputSchema: z.object({
  sha: z
    .string()
    .trim()
    .min(7)
    .optional()
    .describe("可选提交 SHA；省略时读取 dev 分支最新提交。")
}),
outputSchema: {
  protocol: z.string(),
  repository: z.string(),
  branch: z.string(),
  requested_ref: z.string(),
  commit: z.string(),
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
      changes: z.number(),
      patch_available: z.boolean(),
      patch: z.string().nullable()
    })
  )
},
    annotations: {
      readOnlyHint: true
    }
  },
    async ({ sha }) => {
      try {
       const patch = await getPatch(env, sha);

return {
  structuredContent: patch,
  content: [
    {
      type: "text",
      text:
        `已获取提交 ${patch.commit} 的 patch，` +
        `共 ${patch.files.length} 个文件，` +
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
      description:
        "将 ChatGPT 的代码审查结果写入 dev 分支根目录 review.json。此工具只能写 review.json，不能修改源代码。",
      inputSchema: z.object({
        commit: z
          .string()
          .regex(/^[0-9a-fA-F]{40}$/)
          .describe("本次审查对应的完整 Git commit SHA。"),

        verdict: z.enum([
          "approved",
          "changes_requested",
          "blocked"
        ]),

        summary: z
          .string()
          .trim()
          .min(1)
          .max(10000),

        findings: z
          .array(
            z.object({
              severity: z.enum([
                "critical",
                "high",
                "medium",
                "low",
                "info"
              ]),

              file: z
                .string()
                .trim()
                .min(1)
                .max(500),

              line: z
                .number()
                .int()
                .positive()
                .nullable()
                .optional(),

              title: z
                .string()
                .trim()
                .min(1)
                .max(300),

              description: z
                .string()
                .trim()
                .min(1)
                .max(5000),

              recommendation: z
                .string()
                .trim()
                .min(1)
                .max(5000)
            })
          )
          .max(100)
      })
    },
    async (input) => {
      try {
        const result = await submitReview(env, input);

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
      description:
        "读取指定 Git 提交中的原始 UTF-8 文件内容，并返回 SHA-256、字节长度、行尾类型等校验信息。" +
        "当审查涉及转义符、引号、Unicode、Base64、JSON 格式、文件末尾换行或编码时，" +
        "必须调用此工具核实原始文件后才能形成 finding。",

      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("仓库相对路径，例如 worker.js 或 src/index.js。"),

        ref: z
          .string()
          .regex(/^[0-9a-fA-F]{40}$/)
          .describe("要读取的完整 Git commit SHA。")
      },

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
        readOnlyHint: true
      }
    },

    async ({ path, ref }) => {
      try {
        const result = await getFileContent(env, path, ref);

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

function getRepositoryConfig(env) {
  return {
    owner: env.GITHUB_OWNER || DEFAULT_OWNER,
    repo: env.GITHUB_REPO || DEFAULT_REPO,
    branch: env.GITHUB_BRANCH || DEFAULT_BRANCH,
    token: env.GITHUB_TOKEN
  };
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "xinbaijin-mcp-worker",
    "x-github-api-version": "2022-11-28"
  };
}

async function getCommitDetails(env, ref) {
  const { owner, repo, token } = getRepositoryConfig(env);

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;

  const response = await fetch(endpoint, {
    headers: githubHeaders(token)
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `GitHub commit request failed: ${response.status} ${details}`
    );
  }

  return response.json();
}

async function getLatestReviewableCommit(env, startRef) {
  const { branch } = getRepositoryConfig(env);

  let ref = startRef || branch;

  for (let index = 0; index < 20; index += 1) {
    const commit = await getCommitDetails(env, ref);

    const files = Array.isArray(commit.files)
      ? commit.files
      : [];

    const isReviewOnlyCommit =
      files.length > 0 &&
      files.every((file) => file.filename === "review.json");

    if (!isReviewOnlyCommit) {
      return commit;
    }

    const parentSha = commit.parents?.[0]?.sha;

    if (!parentSha) {
      break;
    }

    ref = parentSha;
  }

  throw new Error(
    "Unable to locate the latest reviewable code commit."
  );
}

async function getExistingReviewFileSha(env) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env);

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}/contents/review.json` +
    `?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(endpoint, {
    headers: githubHeaders(token)
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Unable to read existing review.json: ${response.status} ${details}`
    );
  }

  const file = await response.json();

  return file.sha || null;
}

function encodeGitRef(ref) {
  return ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function getBranchHeadSha(env) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env);

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/git/ref/heads/${encodeGitRef(branch)}`;

  const response = await fetch(endpoint, {
    headers: githubHeaders(token)
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Unable to read branch head: ${response.status} ${details}`
    );
  }

  const ref = await response.json();
  const sha = String(ref.object?.sha || "").toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      "GitHub returned an invalid branch head SHA."
    );
  }

  return sha;
}

async function createReviewGitCommit(
  env,
  parentSha,
  reviewText,
  commitMessage
) {
  const { owner, repo, token } =
    getRepositoryConfig(env);

  const parentCommit =
    await getCommitDetails(env, parentSha);

  const baseTreeSha =
    parentCommit.commit?.tree?.sha;

  if (!baseTreeSha) {
    throw new Error(
      "Unable to determine the base tree for the branch head."
    );
  }

  const blobResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        content: reviewText,
        encoding: "utf-8"
      })
    }
  );

  if (!blobResponse.ok) {
    const details = await blobResponse.text();

    throw new Error(
      `Unable to create review blob: ${blobResponse.status} ${details}`
    );
  }

  const blob = await blobResponse.json();

  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [
          {
            path: "review.json",
            mode: "100644",
            type: "blob",
            sha: blob.sha
          }
        ]
      })
    }
  );

  if (!treeResponse.ok) {
    const details = await treeResponse.text();

    throw new Error(
      `Unable to create review tree: ${treeResponse.status} ${details}`
    );
  }

  const tree = await treeResponse.json();

  const commitResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        message: commitMessage,
        tree: tree.sha,
        parents: [parentSha]
      })
    }
  );

  if (!commitResponse.ok) {
    const details = await commitResponse.text();

    throw new Error(
      `Unable to create review commit: ${commitResponse.status} ${details}`
    );
  }

  const commit = await commitResponse.json();

  return {
    commitSha: commit.sha,
    blobSha: blob.sha
  };
}

async function updateBranchRefFastForward(
  env,
  newCommitSha
) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env);

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/git/refs/heads/${encodeGitRef(branch)}`;

  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: githubHeaders(token),
    body: JSON.stringify({
      sha: newCommitSha,
      force: false
    })
  });

  if (!response.ok) {
    const details = await response.text();

    if (
      response.status === 409 ||
      response.status === 422
    ) {
      throw new Error(
        "Concurrent branch update detected. The review was not published. " +
        "Run get_latest_handoff and get_patch again before resubmitting."
      );
    }

    throw new Error(
      `Unable to update branch reference: ${response.status} ${details}`
    );
  }

  return response.json();
}

async function submitReview(env, input) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env);

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  // 固定本次写入所基于的分支头。后续所有校验和提交都基于这个不可变 SHA。
  const branchHead =
    await getBranchHeadSha(env);

  const latestCodeCommit =
    await getLatestReviewableCommit(
      env,
      branchHead
    );

  const expectedCommit =
    String(latestCodeCommit.sha || "").toLowerCase();

  const submittedCommit =
    input.commit.toLowerCase();

  if (submittedCommit !== expectedCommit) {
    throw new Error(
      `Stale review rejected. Expected latest code commit ${expectedCommit}, ` +
      `but received ${submittedCommit}. Run get_latest_handoff and get_patch again.`
    );
  }

  const review = {
    protocol: "xinbaijin-review/1.0",
    repository: `${owner}/${repo}`,
    branch,
    reviewed_commit: expectedCommit,
    based_on_branch_head: branchHead,
    verdict: input.verdict,
    summary: input.summary,
    findings: input.findings,
    reviewer: "ChatGPT",
    reviewed_at: new Date().toISOString()
  };

  const reviewText =
    `${JSON.stringify(review, null, 2)}\n`;

  const commitMessage =
    `chore(review): ${input.verdict} ` +
    `${expectedCommit.slice(0, 7)} [skip-review]`;

  // 先创建一个以 branchHead 为唯一父提交的候选提交。
  const created =
    await createReviewGitCommit(
      env,
      branchHead,
      reviewText,
      commitMessage
    );

  // 最后用非强制 fast-forward 更新分支。
  // 若 branchHead 已变化，这一步会失败，旧审查不会落到新代码之上。
  await updateBranchRefFastForward(
    env,
    created.commitSha
  );

  return {
    ok: true,
    protocol: review.protocol,
    repository: review.repository,
    branch,
    path: "review.json",
    reviewed_commit: expectedCommit,
    based_on_branch_head: branchHead,
    verdict: input.verdict,
    review_commit: created.commitSha,
    file_sha: created.blobSha,
    message: "review.json updated successfully"
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
  ref
) {
  const {
    owner,
    repo,
    token
  } = getRepositoryConfig(env);

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


