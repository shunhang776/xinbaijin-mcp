export default {
  async fetch(request) {
    const body = await request.json();

    const repo = body.repository?.full_name;
    const commits = body.commits || [];
    const lastCommit = commits[commits.length - 1];

    return new Response(JSON.stringify({
      ok: true,
      repo: repo,
      commit_count: commits.length,
      message: lastCommit?.message
    }), {
      headers: { "content-type": "application/json" }
    });
  }
};
