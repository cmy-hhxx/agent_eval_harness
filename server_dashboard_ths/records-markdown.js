import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

function parseMarkdown(source) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

export function markdownPreview(source) {
  function text(node) {
    if (["definition", "footnoteDefinition", "html"].includes(node.type)) return "";
    if (typeof node.value === "string") return node.value;
    if (node.type === "image" || node.type === "imageReference") return node.alt || "";
    const separator = ["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(node.type) ? " " : "";
    return (node.children || []).map(text).join(separator);
  }
  // Only parse enough text for the compact overview; full answers stay lazy.
  return text(parseMarkdown(source.slice(0, 1000))).replace(/\s+/g, " ").trim();
}

// Build DOM nodes instead of interpreting answer HTML. Links share one protocol allowlist.
export function renderMarkdown(source) {
  const tree = parseMarkdown(source);
  const definitions = new Map(tree.children.filter(node => node.type === "definition").map(node => [node.identifier, node]));
  const element = (tag, children = []) => {
    const node = document.createElement(tag);
    node.append(...children);
    return node;
  };
  const safeUrl = value => {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  function render(node) {
    const children = () => (node.children || []).map(render);
    if (node.type === "text" || node.type === "html") return document.createTextNode(node.value);
    if (node.type === "definition") return document.createTextNode("");
    if (node.type === "root") { const fragment = document.createDocumentFragment(); fragment.append(...children()); return fragment; }
    if (node.type === "heading") return element(`h${node.depth}`, children());
    if (node.type === "inlineCode") return element("code", [node.value]);
    if (node.type === "code") return element("pre", [element("code", [node.value])]);
    if (node.type === "break") return element("br");
    if (node.type === "thematicBreak") return element("hr");
    if (node.type === "list") {
      const list = element(node.ordered ? "ol" : "ul", children());
      if (node.ordered && node.start !== null) list.start = node.start;
      return list;
    }
    if (node.type === "listItem") {
      const item = element("li", children());
      if (typeof node.checked === "boolean") {
        const check = document.createElement("input");
        check.type = "checkbox"; check.disabled = true; check.checked = node.checked;
        item.prepend(check);
      }
      return item;
    }
    if (node.type === "table") {
      const table = element("table");
      node.children.forEach((row, index) => {
        const cells = row.children.map((cell, column) => {
          const value = element(index ? "td" : "th", cell.children.map(render));
          if (!index) value.scope = "col";
          if (node.align[column]) value.style.textAlign = node.align[column];
          return value;
        });
        if (!index) table.append(element("thead", [element("tr", cells)]));
        else {
          if (!table.tBodies.length) table.append(element("tbody"));
          table.tBodies[0].append(element("tr", cells));
        }
      });
      const scroll = element("div", [table]);
      scroll.className = "markdown-table-scroll";
      scroll.tabIndex = 0;
      scroll.setAttribute("aria-label", "回答中的表格，可横向滚动");
      return scroll;
    }
    if (["link", "linkReference", "image", "imageReference"].includes(node.type)) {
      const target = node.type.endsWith("Reference") ? definitions.get(node.identifier) : node;
      const url = safeUrl(target?.url);
      const isImage = node.type.startsWith("image");
      if (!url) return isImage ? document.createTextNode(node.alt || "") : element("span", children());
      if (isImage) {
        const image = element("img");
        image.src = url; image.alt = node.alt || ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
        return image;
      }
      const link = element("a", children());
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
      if (target.title) link.title = target.title;
      return link;
    }
    if (node.type === "footnoteReference") return element("sup", [node.label || node.identifier]);
    const tags = { paragraph: "p", strong: "strong", emphasis: "em", delete: "del", blockquote: "blockquote", footnoteDefinition: "aside" };
    return element(tags[node.type] || "span", children());
  }
  return render(tree);
}
