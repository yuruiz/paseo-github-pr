import { decodeHTML } from "entities";
export type MarkdownContext = { repo: string; sha: string; prUrl: string };
export function markdownTarget(
  href: string,
  context: MarkdownContext,
  image = false,
): string | undefined {
  const value = decodeHTML(href).trim();
  if (!value) return undefined;
  const root = image
    ? `https://raw.githubusercontent.com/${context.repo}/${context.sha}/`
    : `https://github.com/${context.repo}/blob/${context.sha}/`;
  try {
    const url = new URL(
      value,
      value.startsWith("#")
        ? context.prUrl
        : value.startsWith("/") && !value.startsWith("//")
          ? "https://github.com"
          : root,
    );
    if (
      !(image ? ["https:", "http:"] : ["https:", "http:", "mailto:"]).includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
