import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

type GhResult = { ok: true; stdout: string } | { ok: false; stderr: string };

function safeJsonParse<T>(value: string | undefined, fallback: T): T {
  try {
    if (!value) return fallback;
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toArrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRepoName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeErrorMessage(value: string, manifestUrl: string): string {
  if (!value) return "";
  let s = String(value).toLowerCase();
  if (manifestUrl) {
    const normalizedManifest = String(manifestUrl).toLowerCase();
    s = s.split(normalizedManifest).join("<manifest_url>");
  }
  s = s.replace(/\bhttps?:\/\/\S+/gi, "<url>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>");
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
  s = s.replace(/:\d{2,5}\b/g, ":<port>");
  s = s.replace(/\b\d+\b/g, "<num>");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function gh(args: string[], options: Record<string, unknown> = {}): string {
  const stdout = execFileSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
  return String(stdout).trim();
}

function ghTry(args: string[], options: Record<string, unknown> = {}): GhResult {
  try {
    return { ok: true, stdout: gh(args, options) };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr ? String((error as { stderr?: unknown }).stderr) : String(error);
    return { ok: false, stderr };
  }
}

function truncate(value: string, maxChars: number): string {
  const s = String(value ?? "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 50))}\n\n...[truncated ${s.length - maxChars} chars]`;
}

function getFailureFromWorkflowPayload(eventName: string, payload: any) {
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

function pickTargetRepoForPluginError(payload: any): string {
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

function pickDiagnosticsRepo(payload: any): string {
  const triggerRepo = normalizeRepoName(payload?.trigger?.repo);
  if (!triggerRepo) return "";
  const owner = triggerRepo.split("/")[0] || "";
  if (!owner) return "";
  return `${owner}/.ubiquity-os`;
}

function resolveSourceRepo(payload: any): string {
  const bySettings = payload?.plugin?.settings?.with?.sourceRepo ?? payload?.plugin?.settings?.sourceRepo;
  if (bySettings) return normalizeRepoName(bySettings);
  const owner = payload?.plugin?.owner ?? "";
  const repo = payload?.plugin?.repo ?? "";
  return normalizeRepoName(owner && repo ? `${owner}/${repo}` : "");
}

function resolveSourceRef(payload: any): string {
  return String(payload?.plugin?.settings?.with?.sourceRef ?? payload?.plugin?.settings?.sourceRef ?? payload?.plugin?.ref ?? "");
}

function resolveSourceSha(sourceRepo: string, sourceRef: string): string {
  if (!sourceRepo || !sourceRef) return "";
  const res = ghTry(["api", `repos/${sourceRepo}/commits/${sourceRef}`, "--jq", ".sha"]);
  if (!res.ok) return "";
  return res.stdout.trim();
}

function formatPluginErrorIssueBody({
  payload,
  stateId,
  key,
  maxBodyChars,
  resolvedSourceSha,
}: {
  payload: any;
  stateId: string;
  key: string;
  maxBodyChars: number;
  resolvedSourceSha: string;
}): string {
  const timestamp = payload?.timestamp ?? "";
  const env = payload?.environment ?? payload?.source?.environment ?? "";
  const configPath = payload?.configPath ?? "";
  const configSources = payload?.config?.sources ?? [];

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
  const logTrail = payload?.logTrail ?? null;
  const kernelVersion = payload?.kernel?.version ?? "";
  const kernelCommit = payload?.kernel?.commit ?? "";
  const pluginSourceRepo = pickTargetRepoForPluginError(payload);
  const pluginSourceRef = resolveSourceRef(payload);
  const pluginSourceSha =
    resolvedSourceSha || payload?.plugin?.settings?.with?.sourceSha || payload?.plugin?.settings?.sourceSha || "";

  const repro = payload?.repro ?? null;

  const lines: string[] = [];
  lines.push("Automated report from UbiquityOS (`kernel.plugin_error`).");
  lines.push("");
  lines.push(`<!-- uos-hotfix-key:${key} -->`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Timestamp: ${timestamp || "n/a"}`);
  lines.push(`- Environment: ${env || "n/a"}`);
  lines.push(`- StateId: ${stateId || "n/a"}`);
  lines.push(`- Config Path: ${configPath || "n/a"}`);
  lines.push(`- Kernel Version: ${kernelVersion || "n/a"}`);
  lines.push(`- Kernel Commit: ${kernelCommit || "n/a"}`);
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
  lines.push(`- Source Repo: ${pluginSourceRepo || "n/a"}`);
  lines.push(`- Source Ref: ${pluginSourceRef || "n/a"}`);
  if (pluginSourceSha) {
    lines.push(`- Source Sha: ${pluginSourceSha}`);
  }
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
  if (Array.isArray(configSources) && configSources.length) {
    lines.push("");
    lines.push("## Config Sources");
    for (const source of configSources) {
      if (!source) continue;
      const sourceOwner = source?.owner ?? "";
      const sourceRepo = source?.repo ?? "";
      const sourcePath = source?.path ?? "";
      const sourceSha = source?.sha ?? "";
      lines.push(`- ${sourceOwner}/${sourceRepo}:${sourcePath} (${sourceSha || "n/a"})`);
    }
  }
  if (logTrail && Array.isArray(logTrail.lines) && logTrail.lines.length) {
    lines.push("");
    lines.push("## Log Trail");
    lines.push("```");
    lines.push(logTrail.lines.join("\n"));
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

function formatWorkflowFailureIssueBody({
  failure,
  payload,
  key,
  maxBodyChars,
}: {
  failure: {
    repo: string;
    type: string;
    name: string;
    conclusion: string;
    htmlUrl?: string;
  };
  payload: any;
  key: string;
  maxBodyChars: number;
}): string {
  const repo = payload?.repository?.full_name ?? "";
  const sender = payload?.sender?.login ?? "";
  const lines: string[] = [];
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

function getExistingIssueNumberByKey({ repo, key }: { repo: string; key: string }): number | null {
  const q = [`repo:${repo}`, "is:issue", "in:body", `"uos-hotfix-key:${key}"`].join(" ");

  const res = ghTry(["api", "search/issues", "-f", `q=${q}`, "--jq", ".items[0].number"]);
  if (!res.ok) return null;
  const n = Number(res.stdout);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function upsertIssue({
  repo,
  title,
  body,
  comment,
  labels,
}: {
  repo: string;
  title: string;
  body: string;
  comment: string;
  labels: string[];
}) {
  const keyMatch = body.match(/uos-hotfix-key:([0-9a-f]{64})/i) || comment.match(/uos-hotfix-key:([0-9a-f]{64})/i);
  const key = keyMatch?.[1] ?? "";
  const existingIssueNumber = key ? getExistingIssueNumberByKey({ repo, key }) : null;

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
  const payload = safeJsonParse<any>(process.env.EVENT_PAYLOAD, null);
  const settings = safeJsonParse<any>(process.env.SETTINGS, {});
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

  const isRepoAllowed = (repo: string) => {
    const normalized = normalizeRepoName(repo);
    if (!normalized) return false;
    if (!allowlistRepos.length) return true;
    return allowlistRepos.includes(normalized);
  };

  if (eventName === "kernel.plugin_error") {
    const diagnosticsRepo = pickDiagnosticsRepo(payload);
    const targetRepo = pickTargetRepoForPluginError(payload);
    if (!diagnosticsRepo) {
      console.log("No diagnostics repo resolved for kernel.plugin_error; skipping.");
      return;
    }
    if (selfRepo && normalizeRepoName(diagnosticsRepo) === selfRepo) {
      console.log("Skipping self-referential kernel.plugin_error to prevent loops.");
      return;
    }
    const allowRepo = payload?.trigger?.repo ?? diagnosticsRepo;
    if (!isRepoAllowed(allowRepo)) {
      console.log(`Repo not allowlisted (${allowRepo}); skipping.`);
      return;
    }

    const pluginId = String(payload?.plugin?.id ?? "");
    const category = String(payload?.error?.category ?? "");
    const message = String(payload?.error?.message ?? "");
    const env = String(payload?.environment ?? payload?.source?.environment ?? "");
    const manifestUrl =
      String(payload?.manifestUrl ?? "") || (pluginId.startsWith("http") ? `${pluginId.replace(/\/$/, "")}/manifest.json` : "");
    const normalizedMessage = normalizeErrorMessage(message, manifestUrl);
    const key = sha256Hex([payload?.event, pluginId, targetRepo, category, normalizedMessage, env].join("|"));
    const title = truncate(`[UOS Hotfix] Plugin failure: ${pluginId || targetRepo} (${key.slice(0, 8)})`, 240);

    const sourceRepo = resolveSourceRepo(payload);
    const sourceRef = resolveSourceRef(payload);
    const resolvedSourceSha = resolveSourceSha(sourceRepo, sourceRef);

    const body = formatPluginErrorIssueBody({ payload, stateId, key, maxBodyChars, resolvedSourceSha });
    const comment = truncate(
      `New occurrence detected.\n\n<!-- uos-hotfix-key:${key} -->\n\n- Timestamp: ${payload?.timestamp ?? "n/a"}`,
      5000,
    );

    const result = upsertIssue({ repo: diagnosticsRepo, title, body, comment, labels: issueLabels });
    if (result.action === "failed") {
      console.error(`Failed to create/update issue in ${diagnosticsRepo}: ${result.error}`);
      return;
    }
    console.log(`${result.action} issue in ${diagnosticsRepo}`);
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
