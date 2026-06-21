// 白名单仓库配置 — 唯一入口，所有仓库解析必须经过此处
const REPOSITORIES = Object.freeze({
  xinbaijin: {
    owner: "shunhang776",
    repo: "xinbaijin",
    branch: "dev"
  },
  "xinbaijin-mcp": {
    owner: "shunhang776",
    repo: "xinbaijin-mcp",
    branch: "dev"
  }
});

// Canonical repository name list — single source of truth for whitelist.
// mcp-schemas.js derives its Zod enum from this array.
export const REPOSITORY_NAMES = Object.freeze(Object.keys(REPOSITORIES));

const DEFAULT_REPOSITORY = "xinbaijin";

function getRepositoryConfig(env, repositoryName) {
  if (!repositoryName) {
    throw new Error(
      "repository is required. Choose xinbaijin or xinbaijin-mcp."
    );
  }
  const name = repositoryName;
  const repoConfig = REPOSITORIES[name];

  if (!repoConfig) {
    throw new Error(
      `Unknown repository: "${name}". ` +
      `Allowed: ${Object.keys(REPOSITORIES).join(", ")}`
    );
  }

  return {
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    branch: repoConfig.branch,
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

async function getCommitDetails(env, ref, repositoryName) {
  const { owner, repo, token } = getRepositoryConfig(env, repositoryName);

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

function isReviewOnlyCommit(commit) {
  const files = Array.isArray(commit.files)
    ? commit.files
    : [];

  return (
    files.length > 0 &&
    files.every(
      (file) => file.filename === "review.json"
    )
  );
}

async function getReviewMetadata(env, ref, repositoryName) {
  const {
    owner,
    repo,
    token
  } = getRepositoryConfig(env, repositoryName);

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/contents/review.json?ref=${encodeURIComponent(ref)}`;

  const response = await fetch(endpoint, {
    headers: githubHeaders(token)
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const file = await response.json();

  if (
    Array.isArray(file) ||
    file.type !== "file" ||
    file.encoding !== "base64" ||
    typeof file.content !== "string"
  ) {
    return null;
  }

  try {
    const cleanBase64 =
      file.content.replace(/\s/g, "");

    const binary = atob(cleanBase64);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );

    const text = new TextDecoder(
      "utf-8",
      { fatal: true }
    ).decode(bytes);

    const parsed = JSON.parse(text);

    return (
      parsed &&
      typeof parsed === "object"
        ? parsed
        : null
    );
  } catch {
    return null;
  }
}

async function isAncestorCommit(
  env,
  ancestorSha,
  descendantSha,
  repositoryName
) {
  const {
    owner,
    repo,
    token
  } = getRepositoryConfig(env, repositoryName);

  const endpoint =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/compare/${encodeURIComponent(ancestorSha)}` +
    `...${encodeURIComponent(descendantSha)}`;

  const response = await fetch(endpoint, {
    headers: githubHeaders(token)
  });

  if (!response.ok) {
    return false;
  }

  const comparison = await response.json();

  return (
    comparison.status === "ahead" ||
    comparison.status === "identical"
  );
}

async function getLatestReviewableCommit(env, startRef, repositoryName) {
  const MAX_TOTAL_WALK = 100; // unified cap for both fast-path and fallback
  const { branch } = getRepositoryConfig(env, repositoryName);

  const initialRef = startRef || branch;
  let commit =
    await getCommitDetails(env, initialRef, repositoryName);

  if (!isReviewOnlyCommit(commit)) {
    return commit;
  }

  // Shared state: walker and counter reused across fast-path and fallback
  let walker = null;
  let totalWalkSteps = 0;

  // Fast path: a review-only head contains the exact code commit
  // that was reviewed. Validate that the target exists, is a code
  // commit, and is an ancestor of the captured branch head.
  const metadata =
    await getReviewMetadata(env, initialRef, repositoryName);

  const reviewedCommit = String(
    metadata?.reviewed_commit || ""
  ).toLowerCase();

  if (/^[0-9a-f]{40}$/.test(reviewedCommit)) {
    try {
      const candidate =
        await getCommitDetails(
          env,
          reviewedCommit,
          repositoryName
        );

      const reachable =
        await isAncestorCommit(
          env,
          reviewedCommit,
          String(commit.sha || initialRef),
          repositoryName
        );

      if (
        !reachable ||
        isReviewOnlyCommit(candidate)
      ) {
        // Fall through to parent traversal.
      } else {
        // Verify every commit between branch head and candidate
        // is review-only. If any non-review-only commit sits between
        // them, the candidate is stale and we must walk parents.
        // Shares totalWalkSteps with fallback to enforce a unified cap.
        walker = commit;
        const walkVisited = new Set();
        let fastPathValid = true;

        while (true) {
          const walkerSha = String(walker.sha || "").toLowerCase();
          if (walkerSha === reviewedCommit) break; // reached candidate
          if (totalWalkSteps >= MAX_TOTAL_WALK) {
            fastPathValid = false;
            break;
          }
          if (!walkerSha || walkVisited.has(walkerSha)) {
            fastPathValid = false;
            break;
          }
          walkVisited.add(walkerSha);
          totalWalkSteps++;

          if (!isReviewOnlyCommit(walker)) {
            fastPathValid = false;
            break;
          }

          const walkerParent = walker.parents?.[0]?.sha;
          if (!walkerParent) {
            fastPathValid = false;
            break;
          }

          walker = await getCommitDetails(env, walkerParent, repositoryName);
        }

        if (fastPathValid) {
          return candidate;
        }
      }
    } catch {
      // Fall back to parent traversal below.
    }
  }

  // Fast path did not return — resume from walker position to avoid
  // re-reading commits the fast path already checked.
  if (walker && walker.sha) {
    commit = walker;
  }

  // Fallback: follow first parents. Shares totalWalkSteps with fast path.
  const visited = new Set();

  while (true) {
    const currentSha = String(
      commit.sha || ""
    ).toLowerCase();

    if (totalWalkSteps >= MAX_TOTAL_WALK) {
      throw new Error(
        "Commit history too deep: exceeded " + MAX_TOTAL_WALK +
        " parent traversals while searching for the latest code commit."
      );
    }

    if (
      currentSha &&
      visited.has(currentSha)
    ) {
      throw new Error(
        "Commit history cycle detected while locating the latest reviewable code commit."
      );
    }

    if (currentSha) {
      visited.add(currentSha);
    }

    if (!isReviewOnlyCommit(commit)) {
      return commit;
    }

    const parentSha =
      commit.parents?.[0]?.sha;

    if (!parentSha) {
      throw new Error(
        "Unable to locate the latest reviewable code commit."
      );
    }

    totalWalkSteps++;
    commit =
      await getCommitDetails(
        env,
        parentSha,
        repositoryName
      );
  }
}

async function getExistingReviewFileSha(env, repositoryName) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env, repositoryName);

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

async function getBranchHeadSha(env, repositoryName) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env, repositoryName);

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
  commitMessage,
  repositoryName
) {
  const { owner, repo, token } =
    getRepositoryConfig(env, repositoryName);

  const parentCommit =
    await getCommitDetails(env, parentSha, repositoryName);

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
  newCommitSha,
  expectedParentSha,
  repositoryName
) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env, repositoryName);

  // Defense-in-depth: re-read branch head immediately before PATCH.
  // Shrinks the race window. Combined with force:false this ensures
  // the new commit is a descendant of the current tip.
  //
  // NOTE: The re-read + PATCH below is NOT an atomic compare-and-swap.
  // A race window remains between the re-read and the PATCH where another
  // actor could force-push dev to an ancestor. The review commit would
  // still be a descendant of that ancestor, so force:false might allow it.
  //
  // Required operational mitigations:
  //   - Enable branch protection on dev: no force-push, no deletion.
  //   - Ensure submit_review has a single serial writer (no concurrent
  //     review submissions against the same branch).
  //
  // These together close the residual TOCTOU window.
  const currentHead = await getBranchHeadSha(env, repositoryName);

  if (currentHead !== expectedParentSha) {
    throw new Error(
      "Concurrent branch update detected. The review was not published. " +
      "Run get_latest_handoff and get_patch again before resubmitting."
    );
  }

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

async function submitReview(env, input, repositoryName) {
  const { owner, repo, branch, token } =
    getRepositoryConfig(env, repositoryName);

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured in Cloudflare Worker secrets."
    );
  }

  // 固定本次写入所基于的分支头。后续所有校验和提交都基于这个不可变 SHA，
  // 全部使用同一个 repositoryName，禁止跨仓库读写。
  const branchHead =
    await getBranchHeadSha(env, repositoryName);

  const latestCodeCommit =
    await getLatestReviewableCommit(
      env,
      branchHead,
      repositoryName
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
      commitMessage,
      repositoryName
    );

  // 最后用非强制 fast-forward 更新分支。
  // 若 branchHead 已变化，这一步会失败，旧审查不会落到新代码之上。
  await updateBranchRefFastForward(
    env,
    created.commitSha,
    branchHead,
    repositoryName
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
  REPOSITORIES,
  DEFAULT_REPOSITORY,
  getRepositoryConfig,
  submitReview,
  getLatestReviewableCommit,
  githubHeaders
};
