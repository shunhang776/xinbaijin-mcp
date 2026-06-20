const DEFAULT_OWNER = "shunhang776";
const DEFAULT_REPO = "xinbaijin-mcp";
const DEFAULT_BRANCH = "dev";
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
export {
  submitReview,
  getRepositoryConfig,
  githubHeaders
};