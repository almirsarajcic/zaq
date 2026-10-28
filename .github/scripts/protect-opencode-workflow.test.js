// Runs the github-script step of .github/workflows/protect-opencode-workflow.yml
// against a mocked GitHub API.
//
//   node --test .github/scripts/protect-opencode-workflow.test.js

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.join(__dirname, "../workflows/protect-opencode-workflow.yml");

// Extracts the block scalar after `script: |`, as actions/github-script receives it.
function extractScript() {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s+script: \|$/.test(line));
  assert.notEqual(start, -1, "workflow has no github-script block");
  const keyIndent = lines[start].search(/\S/);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(indent)).join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const script = new AsyncFunction("github", "context", "core", "process", extractScript());

const PROTECTED = ".github/workflows/opencode.yml";
const defaultEnv = {
  ZAQ_ALLOWED_ROLES: "maintain,admin",
  ZAQ_PROTECTED_FILES: `${PROTECTED},.github/workflows/protect-opencode-workflow.yml,.github/CODEOWNERS`
};

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// pulls: { [number]: { author, files: [filename | { filename, previous_filename }], changed_files? } }
async function run({
  event = "pull_request_target",
  payload,
  pulls = {},
  roles = {},
  roleError,
  listError,
  comparison,
  queue,
  graphqlError,
  env = defaultEnv
}) {
  const result = { failed: null, info: [], warnings: [], listedPulls: [], basehead: null };
  const core = {
    setFailed: (message) => (result.failed = message),
    info: (message) => result.info.push(message),
    warning: (message) => result.warnings.push(message)
  };

  const fileObjects = (number) =>
    (pulls[number]?.files || []).map((file) => (typeof file === "string" ? { filename: file } : file));
  const restPull = (number) => ({
    number,
    user: { login: pulls[number].author },
    changed_files: pulls[number].changed_files ?? pulls[number].files.length
  });

  const github = {
    rest: {
      pulls: {
        listFiles: Symbol("listFiles"),
        get: async ({ pull_number }) => {
          if (!pulls[pull_number]) throw httpError(404);
          return { data: restPull(pull_number) };
        }
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          result.basehead = basehead;
          return { data: comparison };
        },
        getCollaboratorPermissionLevel: async ({ username }) => {
          if (roleError) throw httpError(roleError);
          if (!(username in roles)) throw httpError(404);
          return { data: { role_name: roles[username] } };
        }
      }
    },
    paginate: async (endpoint, { pull_number }) => {
      assert.equal(endpoint, github.rest.pulls.listFiles);
      if (listError) throw httpError(listError);
      result.listedPulls.push(pull_number);
      return fileObjects(pull_number);
    },
    graphql: async () => {
      if (graphqlError) throw graphqlError;
      return queue;
    }
  };

  if (payload === undefined) {
    payload = event === "pull_request_target" ? { pull_request: restPull(1) } : { merge_group: group };
  }

  await script(github, { eventName: event, repo: { owner: "o", repo: "r" }, payload }, core, { env });
  return result;
}

const group = { base_ref: "refs/heads/main", base_sha: "PARENT", head_sha: "C" };
const compared = (shas, overrides = {}) => ({
  status: "ahead",
  total_commits: shas.length,
  commits: shas.map((sha) => ({ sha })),
  ...overrides
});
const queued = (pairs, totalCount = pairs.length) => ({
  repository: {
    mergeQueue: {
      entries: { totalCount, nodes: pairs.map(([oid, number]) => ({ headCommit: { oid }, pullRequest: { number } })) }
    }
  }
});
const mergeGroup = (options) => run({ event: "merge_group", ...options });

test("pull request: unprotected changes pass", async () => {
  const result = await run({ pulls: { 1: { author: "w", files: ["lib/zaq.ex"] } }, roles: { w: "write" } });
  assert.equal(result.failed, null);
});

test("pull request: writer changing a protected file fails", async () => {
  const result = await run({ pulls: { 1: { author: "w", files: [PROTECTED] } }, roles: { w: "write" } });
  assert.match(result.failed, /#1 modifies protected files: \.github\/workflows\/opencode\.yml/);
  assert.match(result.failed, /role "write"/);
});

for (const role of ["maintain", "admin"]) {
  test(`pull request: ${role} changing a protected file passes`, async () => {
    const result = await run({ pulls: { 1: { author: "m", files: [PROTECTED] } }, roles: { m: role } });
    assert.equal(result.failed, null);
  });
}

test("pull request: renaming a protected file away fails", async () => {
  const files = [{ filename: "moved.yml", previous_filename: ".github/CODEOWNERS" }];
  const result = await run({ pulls: { 1: { author: "w", files } }, roles: { w: "write" } });
  assert.match(result.failed, /modifies protected files: \.github\/CODEOWNERS\./);
});

test("pull request: renaming a file onto a protected path fails", async () => {
  const files = [{ filename: PROTECTED, previous_filename: "other.yml" }];
  const result = await run({ pulls: { 1: { author: "w", files } }, roles: { w: "write" } });
  assert.match(result.failed, /modifies protected files/);
});

test("pull request: non-collaborator and failed permission lookup fail", async () => {
  const pulls = { 1: { author: "x", files: [PROTECTED] } };
  assert.match((await run({ pulls })).failed, /role "none"/);
  const lookupFailed = await run({ pulls, roleError: 500 });
  assert.match(lookupFailed.failed, /role "none"/);
  assert.equal(lookupFailed.warnings.length, 1);
});

test("pull request: an incomplete file list fails closed", async () => {
  const capped = Array.from({ length: 3000 }, (_, index) => `file-${index}`);
  const atCap = await run({ pulls: { 1: { author: "m", files: capped } }, roles: { m: "admin" } });
  assert.match(atCap.failed, /Cannot list every file changed by pull request #1/);

  const short = await run({ pulls: { 1: { author: "w", files: ["a"], changed_files: 2 } } });
  assert.match(short.failed, /Cannot list every file/);
});

test("pull request: file listing errors reject rather than pass", async () => {
  await assert.rejects(run({ pulls: { 1: { author: "w", files: [] } }, listError: 502 }), /HTTP 502/);
});

test("configuration, payload and event errors fail", async () => {
  const pulls = { 1: { author: "w", files: [] } };
  assert.match((await run({ pulls, env: { ZAQ_ALLOWED_ROLES: "admin" } })).failed, /configuration is empty/);
  assert.match((await run({ pulls, payload: {} })).failed, /No pull request payload/);
  assert.match((await run({ pulls, event: "pull_request" })).failed, /Unsupported event "pull_request"/);
});

test("merge group: checks every pull request from the target branch", async () => {
  const result = await mergeGroup({
    pulls: { 1: { author: "w", files: ["a"] }, 2: { author: "w", files: ["b"] } },
    comparison: compared(["B", "C"]),
    queue: queued([["B", 1], ["C", 2]])
  });
  assert.equal(result.failed, null);
  assert.equal(result.basehead, "main...C");
  assert.deepEqual(result.listedPulls, [1, 2]);
});

test("merge group: a writer's protected change in an earlier entry fails", async () => {
  const result = await mergeGroup({
    pulls: { 1: { author: "w", files: [PROTECTED] }, 2: { author: "m", files: ["b"] } },
    roles: { w: "write", m: "maintain" },
    comparison: compared(["B", "C"]),
    queue: queued([["B", 1], ["C", 2]])
  });
  assert.match(result.failed, /#1 modifies protected files/);
});

test("merge group: a maintainer's protected change passes", async () => {
  const result = await mergeGroup({
    pulls: { 1: { author: "m", files: [PROTECTED] }, 2: { author: "w", files: ["b"] } },
    roles: { m: "maintain", w: "write" },
    comparison: compared(["B", "C"]),
    queue: queued([["B", 1], ["C", 2]])
  });
  assert.equal(result.failed, null);
});

test("merge group: a writer's rename away from a protected file fails", async () => {
  const result = await mergeGroup({
    pulls: { 1: { author: "w", files: [{ filename: "x", previous_filename: PROTECTED }] } },
    roles: { w: "write" },
    comparison: compared(["C"]),
    queue: queued([["C", 1]])
  });
  assert.match(result.failed, /#1 modifies protected files/);
});

test("merge group: several commits are attributed to the entry they precede", async () => {
  const result = await mergeGroup({
    pulls: { 1: { author: "w", files: ["a"] }, 2: { author: "w", files: ["b"] } },
    comparison: compared(["B1", "B2", "C"]),
    queue: queued([["B2", 1], ["C", 2], ["LATER", 3]])
  });
  assert.equal(result.failed, null);
  assert.deepEqual(result.listedPulls, [1, 2]);
});

test("merge group: unattributed commits fail closed", async () => {
  const pulls = { 1: { author: "w", files: ["a"] } };
  for (const [shas, entries] of [
    [["B", "X", "C"], [["B", 1]]],
    [["B", "C"], [["B", 1]]],
    [["C"], []]
  ]) {
    const result = await mergeGroup({ pulls, comparison: compared(shas), queue: queued(entries) });
    assert.match(result.failed, /Cannot attribute every merge group commit/);
  }
});

test("merge group: an unverifiable commit range fails closed", async () => {
  const pulls = { 1: { author: "w", files: ["a"] } };
  const queue = queued([["C", 1]]);
  for (const comparison of [
    compared(["C"], { status: "diverged" }),
    compared(["C"], { status: "identical", commits: [], total_commits: 0 }),
    compared(["C"], { total_commits: 101 }),
    compared(["B"])
  ]) {
    const result = await mergeGroup({ pulls, comparison, queue });
    assert.match(result.failed, /Cannot list the merge group's commits from main/);
  }
});

test("merge group: an unreadable queue fails closed", async () => {
  const pulls = { 1: { author: "w", files: ["a"] } };
  const comparison = compared(["C"]);
  for (const queue of [{ repository: { mergeQueue: null } }, queued([["C", 1]], 101)]) {
    assert.match((await mergeGroup({ pulls, comparison, queue })).failed, /Cannot read the main merge queue/);
  }
  const denied = await mergeGroup({ pulls, comparison, graphqlError: new Error("Resource not accessible") });
  assert.match(denied.failed, /Resource not accessible Review this merge group manually\./);
});

test("merge group: a malformed payload fails closed", async () => {
  for (const payload of [{}, { merge_group: { ...group, base_ref: "main" } }, { merge_group: { ...group, head_sha: "" } }]) {
    const result = await mergeGroup({ payload, comparison: compared(["C"]), queue: queued([["C", 1]]) });
    assert.match(result.failed, /missing its base ref or head SHA/);
  }
});
