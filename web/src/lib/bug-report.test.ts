import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TITLE,
  buildIssueUrl,
  formatIssueBody,
  formatIssueTitle,
  isReportSubmittable
} from "./bug-report";

describe("formatIssueTitle", () => {
  test("uses the user-supplied title when present", () => {
    expect(formatIssueTitle({ title: "Chat scrolls jankily" })).toBe("Chat scrolls jankily");
  });

  test("trims surrounding whitespace", () => {
    expect(formatIssueTitle({ title: "  spaced  " })).toBe("spaced");
  });

  test("falls back to DEFAULT_TITLE when blank", () => {
    expect(formatIssueTitle({ title: "" })).toBe(DEFAULT_TITLE);
    expect(formatIssueTitle({ title: "   " })).toBe(DEFAULT_TITLE);
  });
});

describe("isReportSubmittable", () => {
  test("requires whatHappened", () => {
    expect(
      isReportSubmittable({ title: "x", whatHappened: "something", stepsToReproduce: "", expected: "" })
    ).toBe(true);
    expect(
      isReportSubmittable({ title: "x", whatHappened: "  ", stepsToReproduce: "", expected: "" })
    ).toBe(false);
    expect(
      isReportSubmittable({ title: "", whatHappened: "", stepsToReproduce: "", expected: "" })
    ).toBe(false);
  });
});

describe("formatIssueBody", () => {
  test("renders all sections with provided values", () => {
    const body = formatIssueBody(
      {
        title: "Chat scrolls jankily",
        whatHappened: "Scrolling stutters on long threads.",
        stepsToReproduce: "Open a long thread. Scroll.",
        expected: "Smooth scrolling at 60fps."
      },
      {
        packageVersion: "0.1.0",
        gitShortSha: "abc1234",
        gitBranch: "main",
        instance: "demo",
        page: "/chat",
        userAgent: "TestAgent/1.0",
        reportedAt: "2026-05-27T18:00:00.000Z"
      }
    );

    expect(body).toContain("### What happened?");
    expect(body).toContain("Scrolling stutters on long threads.");
    expect(body).toContain("### Steps to reproduce");
    expect(body).toContain("Open a long thread. Scroll.");
    expect(body).toContain("### Expected behavior");
    expect(body).toContain("Smooth scrolling at 60fps.");
    expect(body).toContain("### Diagnostic info");
    expect(body).toContain("- Version: `0.1.0`");
    expect(body).toContain("- Commit: `abc1234` (branch `main`)");
    expect(body).toContain("- Instance: `demo`");
    expect(body).toContain("- Page: `/chat`");
    expect(body).toContain("- User agent: `TestAgent/1.0`");
    expect(body).toContain("- Reported: 2026-05-27T18:00:00.000Z");
    expect(body).toContain("Reported from the Gini in-app bug reporter.");
  });

  test("marks omitted user fields as not provided", () => {
    const body = formatIssueBody(
      { title: "x", whatHappened: "boom", stepsToReproduce: "", expected: "  " },
      {}
    );
    // whatHappened is filled
    expect(body).toContain("boom");
    // Steps + Expected fall back to the placeholder
    const placeholderCount = body.split("_Not provided_").length - 1;
    expect(placeholderCount).toBe(2);
  });

  test("renders sha-only and branch-only diagnostic shapes", () => {
    const shaOnly = formatIssueBody(
      { title: "", whatHappened: "x", stepsToReproduce: "", expected: "" },
      { gitShortSha: "deadbee", gitBranch: "" }
    );
    expect(shaOnly).toContain("- Commit: `deadbee`");
    expect(shaOnly).not.toContain("(branch");

    const branchOnly = formatIssueBody(
      { title: "", whatHappened: "x", stepsToReproduce: "", expected: "" },
      { gitShortSha: null, gitBranch: "feat/x" }
    );
    expect(branchOnly).toContain("- Branch: `feat/x`");
    expect(branchOnly).not.toContain("- Commit:");
  });

  test("emits a placeholder when no diagnostics are available", () => {
    const body = formatIssueBody(
      { title: "", whatHappened: "x", stepsToReproduce: "", expected: "" },
      {}
    );
    expect(body).toContain("_No diagnostic info captured._");
  });
});

describe("buildIssueUrl", () => {
  test("points at the canonical Lilac-Labs/gini-agent repo via the bug_report template", () => {
    const url = buildIssueUrl(
      { title: "T", whatHappened: "x", stepsToReproduce: "", expected: "" },
      {}
    );
    expect(url.startsWith("https://github.com/Lilac-Labs/gini-agent/issues/new?")).toBe(true);
    const parsed = new URL(url);
    // The template parameter is what carries the `bug` label here; the
    // `labels` parameter would 404 for reporters without triage permission.
    expect(parsed.searchParams.get("template")).toBe("bug_report.md");
    expect(parsed.searchParams.get("labels")).toBeNull();
    expect(parsed.searchParams.get("title")).toBe("T");
    expect(parsed.searchParams.get("body")).toContain("### What happened?");
  });

  test("url-encodes special characters in the title and body", () => {
    const url = buildIssueUrl(
      {
        title: "Crash on /chat & #1",
        whatHappened: "Boom — segfault at 100%",
        stepsToReproduce: "",
        expected: ""
      },
      { instance: "demo" }
    );
    // The raw URL is encoded; decoded params should round-trip exactly.
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toBe("Crash on /chat & #1");
    expect(parsed.searchParams.get("body")).toContain("Boom — segfault at 100%");
    expect(parsed.searchParams.get("body")).toContain("- Instance: `demo`");
  });

  test("falls back to DEFAULT_TITLE when title is blank", () => {
    const url = buildIssueUrl(
      { title: "   ", whatHappened: "x", stepsToReproduce: "", expected: "" },
      {}
    );
    expect(new URL(url).searchParams.get("title")).toBe(DEFAULT_TITLE);
  });
});
