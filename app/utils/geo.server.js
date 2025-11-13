// app/utils/geo.server.js
import { Reader } from "@maxmind/geoip2-node";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let reader; // undefined = not initialised, null = failed/no DB

export function initGeo() {
  if (reader === undefined) {
    try {
      const dbPath = join(process.cwd(), "geoipdb", "GeoLite2-Country.mmdb");
      const buf = readFileSync(dbPath);
      reader = Reader.openBuffer(buf);
      console.log("[geo] loaded:", dbPath);
    } catch (err) {
      console.warn("[geo] GeoLite2 DB not available:", err?.code || err?.message);
      reader = null; // remember failure so we don't retry every request
    }
  }
  return reader;
}

export function countryFromIp(ip) {
  if (!ip) return undefined;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|::1|fc00:|fe80:)/i.test(ip)) return undefined;

  const r = initGeo();
  if (!r) return undefined;

  const clean = ip.replace(/^::ffff:/, "");
  const node = r.country(clean);
  return node?.country?.isoCode;
}
