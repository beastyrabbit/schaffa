import { parse } from "parse5";
import { AppError } from "./errors.js";

const forbiddenElements = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
]);

interface HtmlAttribute {
  name: string;
  value: string;
}

interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
}

export function validateHtml(html: string): void {
  const document = parse(html) as unknown as HtmlNode;
  visit(document);
}

function visit(node: HtmlNode): void {
  const tag = node.tagName?.toLowerCase();
  if (tag && forbiddenElements.has(tag)) {
    throw new AppError(`<${tag}> is not allowed in published pages.`, 422, "unsafe_html");
  }

  for (const attribute of node.attrs || []) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim().toLowerCase();
    if (name.startsWith("on")) {
      throw new AppError(`Event handler attribute ${name} is not allowed.`, 422, "unsafe_html");
    }
    if (["href", "src", "action", "formaction", "xlink:href"].includes(name)) {
      if (value.startsWith("javascript:") || value.startsWith("data:text/html")) {
        throw new AppError(`Unsafe URL in ${name} is not allowed.`, 422, "unsafe_html");
      }
    }
    if (tag === "meta" && name === "http-equiv" && value === "refresh") {
      throw new AppError("Meta refresh is not allowed.", 422, "unsafe_html");
    }
  }

  for (const child of node.childNodes || []) visit(child);
}
