import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = await mkdtemp(`${tmpdir()}/paseo-github-ui-`);
const built = await build({
  entryPoints: ["scripts/ui-fixture.tsx"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" },
  alias: { "react-native": "react-native-web" },
  plugins: [
    {
      name: "host-fixture",
      setup(b) {
        b.onResolve({ filter: /^@getpaseo\/plugin\/client(?:\/react-native)?$/ }, (a) => ({
          path: a.path,
          namespace: "host-fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "host-fixture" }, (a) => ({
          contents: a.path.endsWith("react-native")
            ? 'export {ScrollView} from "react-native-web";'
            : `import {useCallback} from "react"; export function useRpc(rpc){return useCallback(async(input)=>{if(rpc.name==="github.snapshot")return structuredClone(window.fixture);window.commands.push(input);window.fixtureCommand?.(input);return {message:"Fixture action recorded"};},[rpc.name]);}`,
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const live = process.env.UI_SNAPSHOT
  ? JSON.parse(await readFile(process.env.UI_SNAPSHOT, "utf8"))
  : null;
const preload = live
  ? `window.liveSnapshot=${JSON.stringify(live).replaceAll("<", "\\u003c")};`
  : "";
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;}#root{display:flex;flex-direction:column;}*{box-sizing:border-box;}</style></head><body><div id="root"></div><script>${preload}${built.outputFiles[0].text.replaceAll("</script>", "<\\/script>")}</script></body></html>`;
await writeFile(`${root}/fixture.html`, html);
const server = createServer((_, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html);
}).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  if (live) {
    for (const [name, width, height] of [
      ["desktop", 1280, 900],
      ["compact", 390, 844],
    ]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.route("https://images.example.test/**", (route) =>
          route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
              "base64",
            ),
          }),
        );
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
        await page.getByRole("button", { name: "All open filter" }).click();
        await page
          .getByRole("button", { name: /^Open .*#/ })
          .first()
          .waitFor();
        await page.screenshot({ path: `${root}/${name}-${theme}-live.png` });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => window.commands.length), 0);
        results.push(
          `${name}/${theme}: current daemon snapshot, read-only render, no overflow or JS errors`,
        );
        await page.close();
      }
    }
  } else {
    for (const [name, width, height] of [
      ["desktop", 1280, 900],
      ["compact", 390, 844],
      ["narrow", 600, 900],
    ]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.route("https://images.example.test/**", (route) =>
          route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
              "base64",
            ),
          }),
        );
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
        await page.getByText("alice · Tracking", { exact: true }).waitFor();
        assert.equal(await page.getByLabel("Repository path", { exact: true }).count(), 0);
        assert.equal(await page.getByLabel("Review PR URL").count(), 0);
        assert.equal(await page.getByLabel("Agent provider/model").count(), 0);
        const groups = page.getByTestId("repository-group");
        assert.deepEqual(await groups.getByRole("heading").allTextContents(), [
          "alpha/repo",
          "org/repo",
        ]);
        assert.deepEqual(
          await groups
            .nth(0)
            .getByRole("button", { name: /^Open .*#/ })
            .allTextContents()
            .then((rows) => rows.length),
          1,
        );
        assert.deepEqual(
          await groups
            .nth(1)
            .getByRole("button", { name: /^Open .*#/ })
            .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
          ["Open org/repo#2", "Open org/repo#4", "Open org/repo#3", "Open org/repo#1"],
        );
        assert.equal(await groups.nth(0).getByLabel("1 pull requests", { exact: true }).count(), 1);
        assert.equal(await groups.nth(1).getByLabel("4 pull requests", { exact: true }).count(), 1);
        await page.getByRole("button", { name: "Collapse alpha/repo", exact: true }).click();
        assert.equal(
          await page.getByRole("button", { name: "Expand alpha/repo", expanded: false }).count(),
          1,
        );
        assert.equal(await page.getByRole("button", { name: "Open alpha/repo#6" }).count(), 0);
        assert.equal(await groups.nth(0).getByLabel("1 pull requests", { exact: true }).count(), 1);
        if (name === "desktop" && theme === "light") {
          await page.evaluate(() => {
            window.fixture.state.account = "poll-verified";
          });
          await page.getByText("poll-verified · Tracking", { exact: true }).waitFor();
          assert.equal(
            await page.getByRole("button", { name: "Expand alpha/repo", expanded: false }).count(),
            1,
          );
          await page.evaluate(() => {
            window.fixture.state.account = "alice";
          });
        }
        await page.getByRole("button", { name: "Collapse org/repo", exact: true }).click();
        assert.equal(await page.getByRole("button", { name: /^Open .*#/ }).count(), 0);
        assert.equal(await page.getByText("You're all caught up", { exact: true }).count(), 0);
        await page.screenshot({ path: `${root}/${name}-${theme}-collapsed.png` });
        await page.getByRole("button", { name: "Expand org/repo", exact: true }).press("Enter");
        await page.getByRole("button", { name: "Expand alpha/repo", exact: true }).press("Space");
        assert.equal(
          await page.getByRole("button", { name: "Collapse alpha/repo", expanded: true }).count(),
          1,
        );
        await page.screenshot({ path: `${root}/${name}-${theme}.png` });
        await page.getByRole("button", { name: "Open org/repo#2", exact: true }).click();
        await page
          .context()
          .route("https://github.com/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "PR navigation verified" }),
          );
        async function verifyGitHubLink(number) {
          const opened = page.waitForEvent("popup");
          await page.getByRole("button", { name: "Open on GitHub ↗", exact: true }).click();
          const tab = await opened;
          await tab.waitForURL(`https://github.com/org/repo/pull/${number}`);
          assert.equal(await tab.evaluate(() => window.opener), null);
          await tab.close();
        }
        await verifyGitHubLink(2);
        await page.getByRole("button", { name: "Inspect result →", exact: true }).click();
        assert.equal(
          await page.getByRole("button", { name: "Confirm this exact publication" }).count(),
          0,
        );
        await page.getByRole("button", { name: "Inspect review publication", exact: true }).click();
        await page.getByText("Preserve the cursor before reconnecting.", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.commands.length), 0);
        await page.screenshot({ path: `${root}/${name}-${theme}-approval.png` });
        await page.getByRole("button", { name: "Confirm this exact publication" }).click();
        assert.deepEqual(await page.evaluate(() => window.commands.at(-1)), {
          action: "publish",
          publicationId: "publication",
          fingerprint: "fixture-exact",
        });
        if (width < 800) await page.getByRole("button", { name: "← Back to PRs" }).click();
        await page.getByRole("button", { name: "Open org/repo#3", exact: true }).click();
        await verifyGitHubLink(3);
        const description = page.getByTestId("markdown-description");
        await description.getByRole("heading", { name: "Repository mappings" }).waitFor();
        await description.getByRole("heading", { name: "Validation" }).waitFor();
        await description.getByText("Complete description ends here.", { exact: true }).waitFor();
        assert.equal(
          await description
            .getByText("Workspace bindings", { exact: true })
            .evaluate((el) => getComputedStyle(el).fontWeight),
          "700",
        );
        assert.equal(await description.getByRole("checkbox").count(), 2);
        assert.equal(await description.getByRole("checkbox", { checked: true }).count(), 1);
        assert.equal(
          await description.getByText("hidden template instructions", { exact: false }).count(),
          0,
        );
        await description.getByText("Fork identity", { exact: true }).waitFor();
        assert.equal(
          await description
            .getByTestId("markdown-code")
            .evaluate((el) => el.scrollWidth > el.clientWidth),
          true,
        );
        if (width === 390)
          assert.equal(
            await description
              .getByTestId("markdown-table")
              .evaluate((el) => el.scrollWidth > el.clientWidth),
            true,
          );
        await description.getByRole("img", { name: "Mapping diagram" }).waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          "Markdown must not widen the page",
        );
        const linked = page.waitForEvent("popup");
        await description.getByRole("link", { name: "PR discussion", exact: true }).click();
        const linkedTab = await linked;
        await linkedTab.waitForURL("https://github.com/org/repo/pull/3");
        await linkedTab.close();
        await page
          .getByText(
            "Regression in the reconnect test. Expected the persisted cursor; received the initial cursor.",
            { exact: true },
          )
          .waitFor();
        await description
          .getByRole("heading", { name: "Repository mappings" })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${root}/${name}-${theme}-overview.png` });
        await page.getByRole("button", { name: "Activity", exact: true }).click();
        await page.getByText("No agent tasks for this PR yet.", { exact: true }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Inspect review publication" }).count(),
          0,
        );
        await page.getByRole("button", { name: "Workspace", exact: true }).click();
        await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
        await page.getByLabel("Repository path", { exact: true }).fill("/example/repository");
        await page.getByRole("button", { name: "Repository missing? Prepare clone" }).click();
        await page
          .getByText(
            "Clone org/repo to /example/repository, then create a Workspace for this PR.",
            {
              exact: true,
            },
          )
          .waitFor();
        assert.equal(
          await page.evaluate(() => window.commands.some((c) => c.action === "takeover")),
          false,
        );
        await page.getByRole("button", { name: "Confirm clone and takeover" }).click();
        assert.equal(await page.evaluate(() => window.commands.at(-1).clone), true);
        await page.getByRole("button", { name: "New review", exact: true }).click();
        await page.getByLabel("Review PR URL").fill("https://github.com/org/repo/pull/2");
        await page.getByRole("button", { name: "← Back to PRs" }).click();
        await page.getByRole("button", { name: "All open filter" }).click();
        assert.deepEqual(await groups.getByRole("heading").allTextContents(), [
          "alpha/repo",
          "org/repo",
          "org/storage",
        ]);
        assert.deepEqual(
          await groups.evaluateAll((els) =>
            els.map((el) => el.querySelectorAll('[role="button"][aria-label^="Open "]').length),
          ),
          [3, 5, 2],
        );
        await page.screenshot({ path: `${root}/${name}-${theme}-repositories.png` });
        await page.getByRole("button", { name: "Collapse org/repo", exact: true }).click();
        await page.getByRole("button", { name: "Attention filter", exact: true }).click();
        assert.equal(
          await page.getByRole("button", { name: "Expand org/repo", expanded: false }).count(),
          1,
        );
        await page.getByRole("button", { name: "All open filter", exact: true }).click();
        await page.getByLabel("Search pull requests").fill("missing repository");
        assert.equal(
          await page.getByRole("button", { name: "Expand org/repo", expanded: false }).count(),
          1,
        );
        assert.equal(await page.getByRole("button", { name: /^Open org\/repo#/ }).count(), 0);
        await page.getByRole("button", { name: "Expand org/repo", exact: true }).click();
        assert.deepEqual(await groups.getByRole("heading").allTextContents(), ["org/repo"]);
        assert.equal(await groups.getByLabel("1 pull requests", { exact: true }).count(), 1);
        assert.equal(await page.getByRole("button", { name: /^Open org\/repo#/ }).count(), 1);
        await page.getByLabel("Search pull requests").fill("");
        await page.getByRole("button", { name: "Open org/repo#4", exact: true }).click();
        await page.getByRole("button", { name: "Actions", exact: true }).click();
        await page.getByRole("button", { name: "Add comment", exact: true }).click();
        await page.getByLabel("Comment body").fill("Manual comment for this PR only.");
        await page.getByRole("button", { name: "Preview comment", exact: true }).click();
        await page.getByRole("button", { name: "Confirm post comment", exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => window.commands.some((c) => c.action === "confirmPRAction")),
          false,
        );
        await page.getByText("Manual comment for this PR only.", { exact: true }).waitFor();
        await page.getByText(/Target: https:\/\/github.com\/org\/repo\/pull\/4/).waitFor();
        await page.getByRole("button", { name: "Confirm post comment", exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.commands.at(-1)), {
          action: "confirmPRAction",
          id: "manual-1",
          fingerprint: "exact-manual-1",
        });
        const closeEntry = page.getByRole("button", { name: "Close PR…", exact: true });
        const entryColors = await closeEntry.evaluate((el) => ({
          border: getComputedStyle(el).borderColor,
          text: getComputedStyle(el.firstElementChild).color,
        }));
        const danger = theme === "dark" ? "rgb(255, 147, 147)" : "rgb(180, 35, 24)";
        assert.deepEqual(entryColors, { border: danger, text: danger });
        await closeEntry.click();
        await page.getByRole("button", { name: "Review close action", exact: true }).click();
        await page.getByRole("button", { name: "Confirm close PR", exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Confirm close PR", exact: true })
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          danger,
        );
        assert.equal(await page.evaluate(() => window.fixture.state.prs.PR_4.state), "open");
        await page.screenshot({ path: `${root}/${name}-${theme}-pr-actions.png` });
        await page.getByRole("button", { name: "Confirm close PR", exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.commands.at(-1)), {
          action: "confirmPRAction",
          id: "manual-2",
          fingerprint: "exact-manual-2",
        });
        assert.equal(await page.evaluate(() => window.fixture.state.prs.PR_4.state), "closed");
        assert.equal(await page.getByRole("button", { name: "Close PR…", exact: true }).count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          "Horizontal overflow",
        );
        assert.deepEqual(errors, []);
        results.push(
          `${name}/${theme}: repository collapse, keyboard toggle, retained filter/search state, list/detail, external PR link after selection changes, search, hidden forms, isolated PR activity, exact publication, manual comment/close and clone confirmation, no overflow or JS errors`,
        );
        await page.close();
      }
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=dark&workspace=1`);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("button", { name: "Configure automation" }).click();
    await page.getByLabel("Agent provider/model").waitFor();
    await page.getByRole("button", { name: "← Back to PRs" }).click();
    await page.getByRole("button", { name: "All open filter" }).click();
    assert.equal(await page.getByRole("button", { name: /^Open org\/repo#/ }).count(), 2);
    await page.getByRole("button", { name: "Open org/repo#5", exact: true }).click();
    await page
      .getByText("Reconcile subscriptions after reconnect", { exact: true })
      .first()
      .waitFor();
    await page.screenshot({ path: `${root}/workspace-compact-dark.png` });
    results.push(
      "Workspace panel: scoped Stack, actual target, collapsible automation, compact back navigation",
    );
    await page.close();
  }
  await writeFile(`${root}/report.json`, JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, root, results }, null, 2));
} finally {
  await browser.close();
  server.close();
}
