import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DefaultTreeAdapterMap, parse, serialize } from "parse5";

// Marp emits local images in both img attributes and slide background CSS.
export async function inlinePresentationAssets(html: string, source: string): Promise<string> {
  const directory = await realpath(path.dirname(source));
  const cache = new Map<string, string>();
  const inline = async (reference: string): Promise<string> => {
    if (!reference.trim()) throw new Error("Presentation asset URLs must not be empty.");
    if (reference.startsWith("data:") || reference.startsWith("#")) return reference;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference) && !reference.startsWith("file:")) {
      throw new Error("Presentation images must be local raster files or embedded data.");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(reference);
    } catch {
      throw new Error("Presentation asset URLs contain invalid percent encoding.");
    }
    const filename = await realpath(
      reference.startsWith("file:") ? fileURLToPath(reference) : path.resolve(directory, decoded),
    );
    const relative = path.relative(directory, filename);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
      throw new Error("Presentation images must be inside the source directory.");
    const existing = cache.get(filename);
    if (existing) return existing;
    const info = await stat(filename);
    if (!info.isFile()) throw new Error("Presentation assets must refer to image files.");
    if (info.size > 2 * 1024 * 1024)
      throw new Error("A presentation image exceeds 2 MiB. Resize it before publishing.");
    const data = await readFile(filename);
    const type = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255
        ? "image/jpeg"
        : /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
          ? "image/gif"
          : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : null;
    if (!type) throw new Error("Local presentation images must be PNG, JPEG, GIF, or WebP.");
    const result = `data:${type};base64,${data.toString("base64")}`;
    cache.set(filename, result);
    return result;
  };
  const css = async (value: string): Promise<string> => {
    if (/@import\b/i.test(value)) throw new Error("Presentation CSS imports are not supported.");
    let result = value;
    for (const match of [
      ...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi),
    ].reverse()) {
      const reference = match[1] ?? match[2] ?? match[3] ?? "";
      if (reference.includes("\\")) throw new Error("Use unescaped presentation asset URLs.");
      const replacement = await inline(reference);
      result =
        result.slice(0, match.index) +
        `url("${replacement}")` +
        result.slice(match.index + match[0].length);
    }
    return result;
  };
  const document = parse(html);
  const visit = async (node: DefaultTreeAdapterMap["node"]): Promise<void> => {
    if ("attrs" in node) {
      for (const attr of node.attrs) {
        if (attr.name === "srcset" || (node.tagName === "link" && attr.name === "href"))
          throw new Error("Presentation contains an unsupported asset reference.");
        if (["src", "poster"].includes(attr.name)) attr.value = await inline(attr.value);
        if (attr.name === "style") attr.value = await css(attr.value);
      }
      if (node.tagName === "style") {
        for (const child of node.childNodes)
          if ("value" in child) child.value = await css(child.value);
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) await visit(child);
  };
  await visit(document);
  return serialize(document);
}
