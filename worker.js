export default {
  async fetch(request) {
    const body = await request.json();

    const repo = body.repository?.full_name;
    const commits = body.commits || [];

    return new Response(JSON.stringify({
      ok: true,
      repo,
      commit_count: commits.length,
      last_commit: commits[commits.length - 1]?.message
    }));
  }
};
