/**
 * AI Cross-Review: Codex (High Recall) → Claude (High Precision)
 *
 * CLI 기반 — API 키 없이 구독(Claude Max + Codex CLI)만으로 동작한다.
 * Self-hosted runner에서 실행된다.
 *
 * Step 1: codex review --base → 광범위 스캔
 * Step 2: claude -p → 정밀 검증
 * Step 3: 결과를 PR 코멘트로 게시
 */

import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";

// ─── Config ──────────────────────────────────────────────
const CONFIG = {
  review_focus: [
    "bugs and logic errors",
    "security vulnerabilities",
    "race conditions and concurrency issues",
    "error handling gaps",
    "performance problems",
    "type safety issues",
  ],
  cli_timeout_ms: 180000, // 3분 per CLI call
};

// ─── CLI Helpers ─────────────────────────────────────────
function runCodexReview(baseBranch) {
  // codex review --base는 프롬프트와 함께 쓸 수 없다. 단독 사용.
  // codex는 모든 출력을 stderr로 보낸다.
  // spawnSync로 쉘을 거치지 않아 injection을 방지하고, stderr에 직접 접근한다.
  const result = spawnSync("codex", ["review", "--base", baseBranch], {
    encoding: "utf-8",
    timeout: CONFIG.cli_timeout_ms,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") throw new Error("Codex review timed out");
    throw new Error(`Codex review failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Codex review failed (exit ${result.status}): ${result.stderr}`);
  }

  // stderr에서 마지막 "codex" 행 이후가 실제 리뷰 결과
  const raw = result.stderr || "";
  const lines = raw.split("\n");
  let lastCodexIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "codex") {
      lastCodexIdx = i;
      break;
    }
  }
  const review = lastCodexIdx >= 0
    ? lines.slice(lastCodexIdx + 1).join("\n").trim()
    : raw.trim();
  return review;
}

function runClaudeValidation(codexResult, diff, prTitle, prBody, focus) {
  let prompt = `You are a precision-focused code review validator.
Below are issues flagged by another AI reviewer, followed by the actual diff.

## PR Title
${prTitle}

## Review Focus
${focus}
`;

  if (prBody) {
    prompt += `\n## PR Description\n${prBody}\n`;
  }

  prompt += `
## Issues Found by First Reviewer
${codexResult}

## Diff
${diff}

Validate each issue:
- verdict: confirmed / likely / uncertain / false_positive
- reasoning: why you made this judgment

Rules:
- Only confirm issues you are 100% certain about.
- If you spot additional critical issues the first reviewer missed, add them.
- Be conservative. False positives waste developer time.

Format each issue clearly with the verdict.`;

  // spawnSync + stdin으로 프롬프트 전달. 쉘을 거치지 않아 injection 방지.
  const result = spawnSync("claude", ["-p"], {
    input: prompt,
    encoding: "utf-8",
    timeout: CONFIG.cli_timeout_ms,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") throw new Error("Claude validation timed out");
    throw new Error(`Claude validation failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Claude validation failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

// ─── Main Review Flow ────────────────────────────────────
async function runReview() {
  console.log("Starting AI Cross-Review (CLI mode)...\n");

  // 1. Read context
  const diff = readFileSync("/tmp/pr_diff.txt", "utf-8");
  const prTitle = process.env.PR_TITLE || "";
  const baseBranch = process.env.BASE_BRANCH || "main";
  let prBody = "";
  if (existsSync("/tmp/pr_body.txt")) {
    prBody = readFileSync("/tmp/pr_body.txt", "utf-8").trim();
  }

  if (!diff.trim()) {
    console.log("No diff found. Skipping review.");
    await postComment("**AI Review**: No changes detected.");
    return;
  }

  const diffLines = diff.split("\n").length;
  console.log(`Diff: ${diffLines} lines`);

  // 2. Detect commit type from PR title
  const typeMatch = prTitle.match(/^(feat|fix|refactor|perf|chore|ci|docs)/);
  const type = typeMatch ? typeMatch[1] : "general";
  const focusMap = {
    feat: "error handling, edge cases, missing validation, feature completeness",
    fix: "is the bug actually fixed, regressions, new side effects",
    refactor: "behavior must be unchanged, flag semantic differences",
    perf: "is the optimization real, correctness issues",
  };
  const focus = focusMap[type] || CONFIG.review_focus.join(", ");
  console.log(`PR type: ${type}, focus: ${focus}\n`);

  // ── Step 1: Codex review ───────────────────────────
  console.log("Step 1: Codex review (high recall)...");
  let codexResult;
  try {
    codexResult = runCodexReview(baseBranch);
    console.log("  Codex review complete");
  } catch (err) {
    console.error(`  Codex review failed: ${err.message}`);
    await postComment(
      "**AI Review**: Codex review failed.\n\n" +
        `Error: \`${err.message}\``
    );
    return;
  }

  // Codex 출력이 비어있으면 종료. 비어있지 않으면 Claude로 전달한다.
  // severity 키워드 카운트는 참고용 — 유무 판단에 쓰지 않는다.
  if (!codexResult.trim()) {
    console.log("  Codex returned empty result — no issues found.");
    await postComment(
      "## AI Cross-Review\n\nNo issues found.\n\n" +
        "<sub>Codex (recall) + Claude (precision)</sub>"
    );
    return;
  }
  const issueCount =
    (codexResult.match(/critical|high|medium|low|\[P\d\]/gi) || []).length;
  console.log(`  ~${issueCount} potential issues found\n`);

  // ── Step 2: Claude validation ──────────────────────
  console.log("Step 2: Claude validation (high precision)...");
  let claudeResult;
  try {
    claudeResult = runClaudeValidation(codexResult, diff, prTitle, prBody, focus);
    console.log("  Claude validation complete\n");
  } catch (err) {
    console.error(`  Claude validation failed: ${err.message}`);
    // Fallback: codex 결과만 게시
    await postComment(
      "## AI Review (Codex only — Claude validation failed)\n\n" +
        "> Claude validation was unavailable. Results are unvalidated.\n\n" +
        codexResult +
        "\n\n<sub>Codex (recall) | Unvalidated</sub>"
    );
    return;
  }

  // ── Step 3: Post combined result ───────────────────
  console.log("Posting results...");
  const comment =
    "## AI Cross-Review\n\n" +
    claudeResult +
    "\n\n---\n" +
    "<sub>Codex (recall) → Claude (precision) | Cross-review by AI</sub>";
  await postComment(comment);
  console.log("Review complete!");
}

// ─── GitHub API ──────────────────────────────────────────
async function postComment(body) {
  const { GITHUB_TOKEN, REPO, PR_NUMBER } = process.env;

  if (!GITHUB_TOKEN || !REPO || !PR_NUMBER) {
    console.log("Missing GitHub env vars. Printing to stdout:\n");
    console.log(body);
    return;
  }

  // 이전 봇 코멘트 삭제
  try {
    const listRes = await fetch(
      `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    const comments = await listRes.json();
    const botComment = comments.find(
      (c) =>
        c.user?.login === "github-actions[bot]" &&
        c.body?.includes("AI Cross-Review")
    );
    if (botComment) {
      await fetch(
        `https://api.github.com/repos/${REPO}/issues/comments/${botComment.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
        }
      );
    }
  } catch (cleanupErr) {
    console.warn("Failed to clean up previous bot comment:", cleanupErr.message);
  }

  // 새 코멘트 게시
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${err}`);
  }

  console.log("Comment posted successfully");
}

// ─── Run ─────────────────────────────────────────────────
runReview().catch((err) => {
  console.error("Review failed:", err);
  process.exit(1);
});
