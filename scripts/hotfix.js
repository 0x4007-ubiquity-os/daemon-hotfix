const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toArrayStrings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRepoName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function gh(args, options = {}) {
  const stdout = execFileSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
  return stdout.trim();
}

function ghTry(args, options = {}) {
  try {
    return { ok: true, stdout: gh(args, options) };
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : String(error);
    return { ok: false, stderr };
  }
}

function truncate(value, maxChars) {
  const s = String(value ?? "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 50))}\n\n...[truncated ${s.length - maxChars} chars]`;
}

function getFailureFromWorkflowPayload(eventName, payload) {
  if (eventName === "workflow_run.completed") {
    const conclusion = payload?.workflow_run?.conclusion ?? "";
    const status = payload?.workflow_run?.status ?? "";
    const repo = payload?.repository?.full_name ?? "";
    if (status !== "completed") return null;
    if (!conclusion || conclusion === "success" || conclusion === "neutral") return null;
    return {
      repo,
      type: "workflow_run",
      id: String(payload?.workflow_run?.id ?? ""),
      name: payload?.workflow_run?.name ?? payload?.workflow?.name ?? "",
      conclusion,
      htmlUrl: payload?.workflow_run?.html_url ?? "",
    };
  }

  if (eventName === "check_suite.completed") {
    const conclusion = payload?.check_suite?.conclusion ?? "";
    const status = payload?.check_suite?.status ?? "";
    const repo = payload?.repository?.full_name ?? "";
    if (status !== "completed") return null;
    if (!conclusion || conclusion === "success" || conclusion === "neutral") return null;
    return {
      repo,
      type: "check_suite",
      id: String(payload?.check_suite?.id ?? ""),
      name: payload?.check_suite?.app?.name ?? "check_suite",
      conclusion,
      htmlUrl: payload?.check_suite?.html_url ?? "",
    };
  }

  if (eventName === "check_run.completed") {
    const conclusion = payload?.check_run?.conclusion ?? "";
    const status = payload?.check_run?.status ?? "";
    const repo = payload?.repository?.full_name ?? "";
    if (status !== "completed") return null;
    if (!conclusion || conclusion === "success" || conclusion === "neutral") return null;
    return {
      repo,
      type: "check_run",
      id: String(payload?.check_run?.id ?? ""),
      name: payload?.check_run?.name ?? "check_run",
      conclusion,
      htmlUrl: payload?.check_run?.html_url ?? "",
    };
  }

  return null;
}

function pickTargetRepoForPluginError(payload) {
  const byRepoFields = normalizeRepoName(`${payload?.plugin?.owner ?? ""}/${payload?.plugin?.repo ?? ""}`);
  if (byRepoFields && !byRepoFields.startsWith("/")) return byRepoFields;

  const bySourceRepo = normalizeRepoName(payload?.plugin?.settings?.with?.sourceRepo);
  if (bySourceRepo) return bySourceRepo;

  const bySourceRepoAlt = normalizeRepoName(payload?.plugin?.settings?.sourceRepo);
  if (bySourceRepoAlt) return bySourceRepoAlt;

  const byId = String(payload?.plugin?.id ?? "");
  const m = byId.match(/^([0-9A-Za-z_.-]+)\/([0-9A-Za-z_.-]+)(?:@.+)?$/);
  if (m) return normalizeRepoName(`${m[1]}/${m[2]}`);

  return "";
}

function formatPluginErrorIssueBody({ payload, stateId, key, maxBodyChars }) {
  const timestamp = payload?.timestamp ?? "";
  const env = payload?.environment ?? payload?.source?.environment ?? "";
  const configPath = payload?.configPath ?? "";

  const triggerRepo = payload?.trigger?.repo ?? "";
  const issueOrPr = payload?.trigger?.issueOrPr;
  const deliveryId = payload?.trigger?.deliveryId ?? "";
  const githubEvent = payload?.trigger?.githubEvent ?? "";
  const actor = payload?.trigger?.actor ?? "";

  const pluginType = payload?.plugin?.type ?? "";
  const pluginId = payload?.plugin?.id ?? "";
  const pluginOwner = payload?.plugin?.owner ?? "";
  const pluginRepo = payload?.plugin?.repo ?? "";
  const pluginWorkflowId = payload?.plugin?.workflowId ?? "";
  const pluginRef = payload?.plugin?.ref ?? "";

  const errCategory = payload?.error?.category ?? "";
  const errStatus = payload?.error?.status ?? "";
  const errMessage = payload?.error?.message ?? "";
  const responseSnippet = payload?.context?.responseSnippet ?? "";
  const requestId = payload?.context?.requestId ?? "";
  const retryCount = payload?.context?.retryCount ?? 0;

  const repro = payload?.repro ?? null;

  const lines = [];
  lines.push("Automated report from UbiquityOS (`kernel.plugin_error`).");
  lines.push("");
  lines.push(`<!-- uos-hotfix-key:${key} -->`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Timestamp: ${timestamp || "n/a"}`);
  lines.push(`- Environment: ${env || "n/a"}`);
  lines.push(`- StateId: ${stateId || "n/a"}`);
  lines.push(`- Config Path: ${configPath || "n/a"}`);
  lines.push("");
  lines.push("## Trigger");
  lines.push(`- GitHub Event: ${githubEvent || "n/a"}`);
  lines.push(`- Delivery Id: ${deliveryId || "n/a"}`);
  lines.push(`- Repo: ${triggerRepo || "n/a"}`);
  lines.push(`- Issue/PR: ${issueOrPr ?? "n/a"}`);
  lines.push(`- Actor: ${actor || "n/a"}`);
  lines.push("");
  lines.push("## Plugin");
  lines.push(`- Type: ${pluginType || "n/a"}`);
  lines.push(`- Id: ${pluginId || "n/a"}`);
  lines.push(`- Repo: ${pluginOwner && pluginRepo ? `${pluginOwner}/${pluginRepo}` : "n/a"}`);
  lines.push(`- Ref: ${pluginRef || "n/a"}`);
  lines.push(`- Workflow: ${pluginWorkflowId || "n/a"}`);
  lines.push("");
  lines.push("## Error");
  lines.push(`- Category: ${errCategory || "n/a"}`);
  lines.push(`- Status: ${errStatus || "n/a"}`);
  lines.push(`- Message: ${errMessage || "n/a"}`);
  lines.push(`- Request Id: ${requestId || "n/a"}`);
  lines.push(`- Retry Count: ${retryCount ?? 0}`);
  if (responseSnippet) {
    lines.push("");
    lines.push("### Response Snippet");
    lines.push("```");
    lines.push(String(responseSnippet));
    lines.push("```");
  }
  if (repro && typeof repro === "object") {
    lines.push("");
    lines.push("## Repro (optional)");
    lines.push("```json");
    lines.push(JSON.stringify(repro, null, 2));
    lines.push("```");
  }
  return truncate(lines.join("\n"), maxBodyChars);
}

function formatWorkflowFailureIssueBody({ failure, payload, key, maxBodyChars }) {
  const repo = payload?.repository?.full_name ?? "";
  const sender = payload?.sender?.login ?? "";
  const lines = [];
  lines.push("Automated report from UbiquityOS (`workflow/check` allowlist).");
  lines.push("");
  lines.push(`<!-- uos-hotfix-key:${key} -->`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Repo: ${repo || "n/a"}`);
  lines.push(`- Type: ${failure.type}`);
  lines.push(`- Name: ${failure.name || "n/a"}`);
  lines.push(`- Conclusion: ${failure.conclusion || "n/a"}`);
  if (failure.htmlUrl) lines.push(`- Run URL: ${failure.htmlUrl}`);
  if (sender) lines.push(`- Sender: ${sender}`);
  return truncate(lines.join("\n"), maxBodyChars);
}

function getExistingIssueNumberByKey({ repo, key, dedupeWindowHours }) {
  const q = [
    `repo:${repo}`,
    "is:issue",
    "in:body",
    `"uos-hotfix-key:${key}"`,
    `updated:>=${new Date(Date.now() - dedupeWindowHours * 60 * 60 * 1000).toISOString().slice(0, 10)}`,
  ].join(" ");

  const res = ghTry(["api", "search/issues", "-f", `q=${q}`, "--jq", ".items[0].number"]);
  if (!res.ok) return null;
  const n = Number(res.stdout);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function upsertIssue({ repo, title, body, comment, labels }) {
  const keyMatch = body.match(/uos-hotfix-key:([0-9a-f]{64})/i) || comment.match(/uos-hotfix-key:([0-9a-f]{64})/i);
  const key = keyMatch?.[1] ?? "";
  const dedupeWindowHours = 24;
  const existingIssueNumber = key ? getExistingIssueNumberByKey({ repo, key, dedupeWindowHours }) : null;

  if (existingIssueNumber) {
    ghTry(["issue", "reopen", String(existingIssueNumber), "--repo", repo]);
    ghTry(["issue", "comment", String(existingIssueNumber), "--repo", repo, "--body", comment]);
    return { action: "updated", number: existingIssueNumber };
  }

  const createArgs = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  for (const label of labels) createArgs.push("--label", label);
  const created = ghTry(createArgs);
  if (!created.ok && labels.length) {
    const createdNoLabels = ghTry(["issue", "create", "--repo", repo, "--title", title, "--body", body]);
    if (createdNoLabels.ok) return { action: "created", url: createdNoLabels.stdout };
  }
  if (!created.ok) {
    return { action: "failed", error: created.stderr };
  }
  return { action: "created", url: created.stdout };
}

function main() {
  const eventName = String(process.env.EVENT_NAME || "");
  const payload = safeJsonParse(process.env.EVENT_PAYLOAD, null);
  const settings = safeJsonParse(process.env.SETTINGS, {});
  const stateId = String(process.env.STATE_ID || "");
  const selfRepo = normalizeRepoName(process.env.GITHUB_REPOSITORY || "");

  if (!payload) {
    console.error("Missing/invalid EVENT_PAYLOAD");
    process.exit(1);
  }

  if (settings && settings.enabled === false) {
    console.log("daemon-hotfix disabled by config");
    return;
  }

  const allowlistRepos = toArrayStrings(settings?.allowlistRepos).map(normalizeRepoName).filter(Boolean);
  const issueLabels = toArrayStrings(settings?.issueLabels);
  const maxBodyChars = Number.isFinite(settings?.maxBodyChars) ? Number(settings.maxBodyChars) : 65000;

  const isRepoAllowed = (repo) => {
    const normalized = normalizeRepoName(repo);
    if (!normalized) return false;
    if (!allowlistRepos.length) return true;
    return allowlistRepos.includes(normalized);
  };

  if (eventName === "kernel.plugin_error") {
    const targetRepo = pickTargetRepoForPluginError(payload);
    if (!targetRepo) {
      console.log("No target repo resolved for kernel.plugin_error; skipping.");
      return;
    }
    if (selfRepo && normalizeRepoName(targetRepo) === selfRepo) {
      console.log("Skipping self-referential kernel.plugin_error to prevent loops.");
      return;
    }
    if (!isRepoAllowed(targetRepo)) {
      console.log(`Repo not allowlisted (${targetRepo}); skipping.`);
      return;
    }

    const pluginId = String(payload?.plugin?.id ?? "");
    const category = String(payload?.error?.category ?? "");
    const message = String(payload?.error?.message ?? "");
    const key = sha256Hex([pluginId, category, message].join("|"));
    const title = truncate(`[UOS Hotfix] Plugin failure: ${pluginId || targetRepo} (${key.slice(0, 8)})`, 240);
    const body = formatPluginErrorIssueBody({ payload, stateId, key, maxBodyChars });
    const comment = truncate(
      `New occurrence detected.\n\n<!-- uos-hotfix-key:${key} -->\n\n- Timestamp: ${payload?.timestamp ?? "n/a"}`,
      5000,
    );

    const result = upsertIssue({ repo: targetRepo, title, body, comment, labels: issueLabels });
    if (result.action === "failed") {
      console.error(`Failed to create/update issue in ${targetRepo}: ${result.error}`);
      return;
    }
    console.log(`${result.action} issue in ${targetRepo}`);
    return;
  }

  const workflowFailure = getFailureFromWorkflowPayload(eventName, payload);
  if (workflowFailure) {
    const targetRepo = workflowFailure.repo;
    if (selfRepo && normalizeRepoName(targetRepo) === selfRepo) {
      console.log("Skipping self workflow/check failure to prevent loops.");
      return;
    }
    if (!isRepoAllowed(targetRepo)) {
      console.log(`Repo not allowlisted (${targetRepo}); skipping.`);
      return;
    }

    const key = sha256Hex([workflowFailure.type, workflowFailure.name, workflowFailure.conclusion].join("|"));
    const title = truncate(
      `[UOS Hotfix] CI failure: ${workflowFailure.name || workflowFailure.type} (${key.slice(0, 8)})`,
      240,
    );
    const body = formatWorkflowFailureIssueBody({ failure: workflowFailure, payload, key, maxBodyChars });
    const comment = truncate(
      `New failure detected.\n\n<!-- uos-hotfix-key:${key} -->\n\n- Conclusion: ${workflowFailure.conclusion}\n- URL: ${workflowFailure.htmlUrl || "n/a"}`,
      5000,
    );

    const result = upsertIssue({ repo: targetRepo, title, body, comment, labels: issueLabels });
    if (result.action === "failed") {
      console.error(`Failed to create/update issue in ${targetRepo}: ${result.error}`);
      return;
    }
    console.log(`${result.action} issue in ${targetRepo}`);
    return;
  }

  console.log(`Ignoring unsupported eventName=${eventName}`);
}

main();
