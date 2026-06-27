import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ breaks: true, gfm: true });

// 论文摘要会经 LLM 流入这里，属信任边界 → 渲染后做白名单清洗，挡 XSS。
const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "em", "a", "code", "pre",
  "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4",
];

/** markdown → 已清洗 HTML（供 dangerouslySetInnerHTML 使用）。 */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? "", { async: false }) as string;
  return sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"], // 去掉 javascript: 等
    transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }) },
  });
}
