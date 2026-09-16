import { DOMParser, parseHTML } from "linkedom";

export interface FeedItem {
  readonly title: string;
  readonly link: string;
  readonly publishedAt: string | undefined;
  readonly summary: string;
  readonly guid: string | undefined;
}

interface XmlParser {
  parseFromString(markup: string, mimeType: "text/xml"): Document;
}

/** Typed XML document for RSS/Atom/CAP feeds; preserves CDATA text. */
export const xmlDocument = (xml: string): Document =>
  (new DOMParser() as unknown as XmlParser).parseFromString(xml, "text/xml");

const textOf = (node: Element | null): string =>
  node?.textContent.trim() ?? "";

const stripMarkup = (value: string): string => {
  if (!value.includes("<")) return value.trim();
  const { document } = parseHTML(`<body>${value}</body>`);
  const text = document.documentElement.textContent;
  return (text === "" ? value.replaceAll(/<[^>]*>/gu, " ") : text).trim();
};

const parseDate = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0 || value.length > 80) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
};

/** RSS 2.0 and Atom items from a bounded XML document. */
export const parseFeed = (xml: string, limit = 40): readonly FeedItem[] => {
  const document = xmlDocument(xml);
  const items: FeedItem[] = [];
  const rssItems = [...document.querySelectorAll("channel > item, item")];
  const atomEntries = rssItems.length === 0 ? [...document.querySelectorAll("entry")] : [];
  for (const item of [...rssItems, ...atomEntries]) {
    const title = stripMarkup(textOf(item.querySelector("title")));
    const rawLink = item.querySelector("link");
    const link = rawLink?.getAttribute("href") ?? textOf(rawLink);
    const published = textOf(item.querySelector("pubDate"))
      || textOf(item.querySelector("published"))
      || textOf(item.querySelector("updated"))
      || textOf(item.querySelector("date"));
    const summary = stripMarkup(
      textOf(item.querySelector("description"))
      || textOf(item.querySelector("summary"))
      || textOf(item.querySelector("content")),
    );
    const guid = textOf(item.querySelector("guid")) || link;
    if (title.length === 0 && link.length === 0) continue;
    items.push({
      title,
      link: link.startsWith("http") ? link.slice(0, 2048) : "",
      publishedAt: parseDate(published),
      summary: summary.slice(0, 2000),
      guid: guid.length > 0 ? guid.slice(0, 512) : undefined,
    });
    if (items.length >= limit) break;
  }
  return items;
};

/** Named elements' visible text from an HTML document, for page scrapers. */
export const htmlDocument = (html: string) => parseHTML(html);

export const htmlText = (html: string): string => {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style,head")) node.remove();
  return document.documentElement.textContent.replaceAll(/\s+/gu, " ").trim();
};

export const absoluteUrl = (base: string, href: string): string | undefined => {
  try {
    const resolved = new URL(href, base);
    return resolved.protocol === "https:" ? resolved.href.slice(0, 2048) : undefined;
  } catch {
    return undefined;
  }
};
