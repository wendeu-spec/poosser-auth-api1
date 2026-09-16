import fr from "./fr.json" with { type: "json" };
import en from "./en.json" with { type: "json" };
import type { Request } from "express";

const catalogs = { fr, en } as const;
export type Locale = keyof typeof catalogs;

export function resolveLocale(req: Request): Locale {
  const header = req.headers["accept-language"];
  if (typeof header === "string" && header.toLowerCase().startsWith("en")) return "en";
  return "fr";
}

export function t(locale: Locale, key: string): string {
  const catalog = catalogs[locale] as Record<string, string>;
  return catalog[key] ?? key;
}
