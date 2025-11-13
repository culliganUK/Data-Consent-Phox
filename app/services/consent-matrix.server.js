// app/services/consent-matrix.server.js
import fs from "fs/promises";
import path from "node:path";
import matrix from "~/data/consent_matrix.json";

// Build two indexes so you can look up by code OR by country name
let cache = null;
async function loadMatrix() {
  if (cache) return cache;
  const file = path.resolve(
    process.cwd(),
    "app/data/consent_matrix.json"
  );
  const rows = JSON.parse(await fs.readFile(file, "utf8"));

  const byCode = new Map();
  const byName = new Map();

  for (const r of rows) {
    const ct = String(r.customer_type || "single").toLowerCase();
    const codeKey = `${String(r.country_code || "").trim().toUpperCase()}|${ct}`;
    const nameKey = `${String(r.country || "").trim().toLowerCase()}|${ct}`;

    const value = {
      widget: r.widget.toUpperCase(), // "OPT_IN" | "OPT_OUT" | "NO_CHECKBOX"
      emailMethod: r.email_method,    // "SOI" | "DOI"
      country: r.country || null,
      countryCode: r.country_code || null,
    };

    byCode.set(codeKey, value);
    byName.set(nameKey, value);
  }

  cache = { byCode, byName };
  return cache;
}

// Pull best matching rule. We accept either code or country name.
// customerType: "single" | "repeat"
export async function pickRule({ code, country, customerType = "single" }) {
  const { byCode, byName } = await loadMatrix();
  const ct = String(customerType).toLowerCase();

  if (code) {
    const hit = byCode.get(`${String(code).toUpperCase()}|${ct}`);
    if (hit) return hit;
  }
  if (country) {
    const hit = byName.get(`${String(country).toLowerCase()}|${ct}`);
    if (hit) return hit;
  }

  // Fallback: UK + "single" with a safe default
  return (
    byCode.get(`GB|${ct}`) ||
    byCode.get(`GB|single`) || {
      widget: "OPT_OUT",
      emailMethod: "SOI",
      country: "United Kingdom",
      countryCode: "GB",
    }
  );
}

// Pull IP country from common edge headers (Cloudflare/Vercel/Railway proxies)
export function detectCountryFromHeaders(request) {
  const h = request.headers;
  const code =
    h.get("cf-ipcountry") ||
    h.get("x-vercel-ip-country") ||
    h.get("x-country-code") ||
    null;
  const name =
    h.get("x-country-name") ||  // optional if your edge adds this
    null;
  return { code, name };
}

// Your checkout UI expects these "opt" values:
//  - "OPT_OUT"     => show checkbox; checked = OPT OUT (i.e., don't subscribe). Default = subscribed.
//  - "OPT_IN"      => show checkbox; checked = OPT IN. Default = not subscribed.
//  - "NO_CHECKBOX" => hide checkbox (no_checkbox).
export function widgetToOpt(widget) {
  switch (widget) {
    case "OPT_IN":
      return "OPT_IN";
    case "OPT_OUT":
      return "OPT_OUT";
    case "NO_CHECKBOX":
      return "NO_CHECKBOX";
    default:
      return "OPT_IN";
  }
}

// Optional: defaultSubscribe you may want to store on the session
export function defaultSubscribeFromWidget(widget) {
  if (widget === "OPT_OUT") return true;      // soft opt-in default
  if (widget === "OPT_IN") return false;      // must opt in
  return null;                                // no checkbox shown
}

export function getCountryNameFromMatrix(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();

  // Try exact matches by common keys (adjust if your JSON has different fields)
  const row =
    matrix.find(
      (r) =>
        r.code?.toUpperCase?.() === c ||
        r.alpha2?.toUpperCase?.() === c ||
        r.countryCode?.toUpperCase?.() === c
    ) || null;

  if (row?.country || row?.name) return row.country || row.name;

  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return dn.of(c) || c;
  } catch {
    return c;
  }
}
