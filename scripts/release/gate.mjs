import assert from "node:assert/strict";

export const REPOSITORY = "SynapseOperator/mq-story-blog";
const shaPattern = /^[a-f0-9]{40}$/;

/** Operator-recorded owner authorization, not a signature or a Review. The
 * referenced local evidence must be retained beside the release evidence. */
export function validateOwnerCiExemption(value, sourceSha) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "RELEASE_CI_EXEMPTION_REJECTED");
  assert.deepEqual(Object.keys(value).sort(), ["localValidationSha256", "reason", "sourceSha", "version"], "RELEASE_CI_EXEMPTION_REJECTED");
  assert.equal(value.version, 1, "RELEASE_CI_EXEMPTION_REJECTED");
  assert.equal(value.sourceSha, sourceSha, "RELEASE_CI_EXEMPTION_SOURCE_MISMATCH");
  assert.equal(value.reason, "owner-approved-github-actions-quota", "RELEASE_CI_EXEMPTION_REJECTED");
  assert.match(value.localValidationSha256 ?? "", /^[a-f0-9]{64}$/, "RELEASE_CI_EXEMPTION_REJECTED");
  return { ...value };
}

/** Read-only GitHub evidence, not a user-supplied approval string. A release
 * may use an older reviewed main commit, but never an unmerged branch head. */
export async function verifyReleaseGate({ sourceSha, request, ownerCiExemption }) {
  assert.match(sourceSha ?? "", shaPattern, "RELEASE_SOURCE_REJECTED");
  const ciExemption = ownerCiExemption === undefined ? undefined : validateOwnerCiExemption(ownerCiExemption, sourceSha);
  const prefix = `/repos/${REPOSITORY}`;
  const main = await request(`${prefix}/git/ref/heads/main`);
  const comparison = await request(`${prefix}/compare/${sourceSha}...${main.object.sha}`);
  assert.ok(["ahead", "identical"].includes(comparison.status)
    && comparison.merge_base_commit.sha === sourceSha, "RELEASE_NOT_ON_MAIN");
  const pulls = await request(`${prefix}/commits/${sourceSha}/pulls?per_page=100`);
  const candidates = pulls.filter(pr => pr.merged_at && pr.base.ref === "main" && pr.merge_commit_sha === sourceSha);
  assert.equal(candidates.length, 1, "RELEASE_MERGE_REVIEW_REQUIRED");
  const pr = await request(`${prefix}/pulls/${candidates[0].number}`);
  assert.ok(pr.merged && pr.merge_commit_sha === sourceSha, "RELEASE_MERGE_REVIEW_REQUIRED");
  const reviews = await request(`${prefix}/pulls/${pr.number}/reviews?per_page=100`, { all: true });
  const reviewer = "SnorkelingBreather";
  const currentReviews = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (!["COMMENTED", "PENDING"].includes(review.state)) currentReviews.set(review.user.login, review);
  }
  assert.ok(![...currentReviews.values()].some(review => review.state === "CHANGES_REQUESTED"), "RELEASE_CHANGES_REQUESTED");
  const latest = currentReviews.get(reviewer);
  assert.ok(latest && latest.state === "APPROVED" && latest.commit_id === pr.head.sha
    && pr.user.login !== reviewer, "RELEASE_CURRENT_REVIEW_REQUIRED");
  const unresolved = await request("reviewThreads", { number: pr.number });
  assert.equal(unresolved, false, "RELEASE_UNRESOLVED_REVIEW");
  const runs = await request(`${prefix}/actions/workflows/ci.yml/runs?head_sha=${sourceSha}&event=push&per_page=100`);
  // The latest attempt, not an older green run while a new run is failing.
  const run = runs.workflow_runs.filter(item => item.head_sha === sourceSha && item.head_branch === "main")
    .sort((a, b) => b.id - a.id)[0];
  if (!ciExemption) assert.ok(run && run.status === "completed" && run.conclusion === "success", "RELEASE_MAIN_CI_REQUIRED");
  const jobs = run ? await request(`${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, { all: true, field: "jobs" }) : [];
  for (const name of ciExemption ? [] : ["quality", "database", "container"]) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, "RELEASE_CI_JOBS_REQUIRED");
    assert.ok(matches[0].status === "completed" && matches[0].conclusion === "success", "RELEASE_CI_JOBS_REQUIRED");
  }
  return { kind: "reviewed-main", repository: REPOSITORY, sourceSha, observedMainSha: main.object.sha,
    pullRequest: pr.number, reviewedHead: pr.head.sha, reviewer, reviewId: latest.id,
    qualityRunId: ciExemption ? null : run.id, checkedAt: new Date().toISOString(),
    ...(ciExemption ? { ciExemption, observedCi: { runId: run?.id ?? null, status: run?.status ?? "missing",
      conclusion: run?.conclusion ?? null, jobs: jobs.filter(job => ["quality", "database", "container"].includes(job.name))
        .map(({ name, status, conclusion }) => ({ name, status, conclusion })) } } : {}) };
}

export function githubRequest(token, fetcher = globalThis.fetch) {
  assert.ok(typeof token === "string" && token.length > 0, "RELEASE_GITHUB_AUTH_REQUIRED");
  async function call(path, body) {
    const response = await fetcher(`https://api.github.com${path}`, { method: body ? "POST" : "GET",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: "error" });
    assert.ok(response.ok, "RELEASE_GITHUB_EVIDENCE_UNAVAILABLE");
    const value = await response.json();
    assert.ok(!value.errors, "RELEASE_GITHUB_EVIDENCE_UNAVAILABLE");
    return value;
  }
  return async (path, { all = false, field, number } = {}) => {
    if (path === "reviewThreads") {
      let cursor = null;
      do {
        const value = await call("/graphql", { query: `query($number:Int!,$cursor:String){repository(owner:"SynapseOperator",name:"mq-story-blog"){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`,
          variables: { number, cursor } });
        const threads = value.data.repository.pullRequest.reviewThreads;
        if (threads.nodes.some(thread => !thread.isResolved)) return true;
        cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
      } while (cursor);
      return false;
    }
    if (!all) return call(path);
    const values = [];
    for (let page = 1; ; page++) {
      const value = await call(`${path}&page=${page}`), rows = field ? value[field] : value;
      assert.ok(Array.isArray(rows), "RELEASE_GITHUB_EVIDENCE_UNAVAILABLE");
      values.push(...rows);
      if (rows.length < 100) return values;
    }
  };
}
