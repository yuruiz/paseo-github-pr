import { expect, test } from "vitest";
import { markdownTarget } from "../client/markdown-links";
const context = {
  repo: "alice/repo",
  sha: "a".repeat(40),
  prUrl: "https://github.com/org/repo/pull/3",
};
test("relative Markdown file and image links resolve to the PR head repository and SHA", () => {
  expect(markdownTarget("docs/guide.md", context)).toBe(
    `https://github.com/alice/repo/blob/${context.sha}/docs/guide.md`,
  );
  expect(markdownTarget("images/result.png", context, true)).toBe(
    `https://raw.githubusercontent.com/alice/repo/${context.sha}/images/result.png`,
  );
  expect(markdownTarget("/org/repo/issues/9", context)).toBe(
    "https://github.com/org/repo/issues/9",
  );
  expect(markdownTarget("#discussion", context)).toBe(`${context.prUrl}#discussion`);
  expect(markdownTarget("https://example.com/?a=1&amp;b=2", context)).toBe(
    "https://example.com/?a=1&b=2",
  );
});
test.each([
  "javascript:alert(1)",
  "jav&#97;script:alert(1)",
  "data:text/html,test",
  "file:///etc/passwd",
  "vscode://open",
  "https://user:password@example.com",
])("Markdown does not open unsafe destination %s", (href) => {
  expect(markdownTarget(href, context)).toBeUndefined();
  expect(markdownTarget(href, context, true)).toBeUndefined();
});
test("mail links are allowed for text but not image requests", () => {
  expect(markdownTarget("mailto:author@example.com", context)).toBe("mailto:author@example.com");
  expect(markdownTarget("mailto:author@example.com", context, true)).toBeUndefined();
});
