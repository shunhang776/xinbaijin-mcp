export default {
  async fetch(request) {
    // 浏览器健康检查
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "xinbaijin-mcp",
        role: "gateway",
        status: "running"
      });
    }

    // 只接受 POST Webhook
    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "Method not allowed" },
        405
      );
    }

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

    // Worker 只把 GitHub 数据转换为统一 handoff
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
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
