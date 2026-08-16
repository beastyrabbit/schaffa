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
  content?: HtmlNode;
}

export function validateHtml(html: string, interactive = false): void {
  const document = parse(html) as unknown as HtmlNode;
  visit(document, interactive);
}

function visit(node: HtmlNode, interactive: boolean): void {
  const tag = node.tagName?.toLowerCase();
  if (tag && forbiddenElements.has(tag) && !(interactive && tag === "script")) {
    throw new AppError(`<${tag}> is not allowed in published pages.`, 422, "unsafe_html");
  }

  for (const attribute of node.attrs || []) {
    const name = attribute.name.toLowerCase();
    const value = stripAsciiControls(attribute.value).trim().toLowerCase();
    if (name.startsWith("on")) {
      throw new AppError(`Event handler attribute ${name} is not allowed.`, 422, "unsafe_html");
    }
    if (interactive && tag === "script" && name === "src") {
      throw new AppError("External scripts are not allowed.", 422, "unsafe_html");
    }
    if (interactive && tag === "script" && name === "type" && value === "module") {
      throw new AppError("Module scripts are not allowed.", 422, "unsafe_html");
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

  for (const child of node.childNodes || []) visit(child, interactive);
  if (node.content) visit(node.content, interactive);
}

function stripAsciiControls(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}
