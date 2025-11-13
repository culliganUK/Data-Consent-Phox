// app/services/sync-to-klaviyo.server.js
import { prisma } from "~/db.server";
import { dec } from "~/utils/crypto.server";
import { randomUUID } from "crypto";

const KLAVIYO_API = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

// -------- debug helpers --------
const DEBUG = process.env.DEBUG_KLAVIYO === "1";
const dbg = (...args) => { if (DEBUG) console.log("[klaviyo]", ...args); };
const mask = (s) => (s ? `${String(s).slice(0,4)}…${String(s).slice(-4)}` : "");

// -------- http --------
async function fetchJson(url, opts = {}, { rid } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      dbg(rid, "HTTP", res.status, url, text.slice(0,500));
      throw new Error(`${opts.method || "GET"} ${url} -> ${res.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}
function headers(key) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Klaviyo-API-Key ${key}`,
    Revision: REVISION,
  };
}

// -------- klaviyo profile helpers (status-aware) --------
/**
 * Look up a profile by email and return { id, email, status }
 * status: 'subscribed' | 'unsubscribed' | 'suppressed' | 'never_subscribed' | null
 */
async function getProfileByEmail(key, email, { rid }) {
  const filter = encodeURIComponent(`equals(email,"${email}")`);

  // v2024-10-15 requires subscriptions via additional-fields
  const base =
    `${KLAVIYO_API}/profiles?` +
    `filter=${filter}` +
    `&fields[profile]=id,email,first_name,last_name` +
    `&additional-fields[profile]=subscriptions`;

  dbg(rid, "GET profile by email", email);

  // Try with subscriptions first
  try {
    const json = await fetchJson(base, { headers: headers(key) }, { rid });
    const d = json?.data?.[0] || null;
    const id = d?.id || null;
    const status = d?.attributes?.subscriptions?.email?.marketing?.status || null;
    const firstName = d?.attributes?.first_name || null;
    const lastName  = d?.attributes?.last_name || null;

    dbg(rid, "profile lookup result", { id, status });
    return id ? { id, email, status, firstName, lastName } : null;
  } catch (e) {
    // If the server still rejects the additional-fields param (older workspaces, rollout quirks),
    // fall back to a simpler fieldset and just return no status (we’ll treat as unknown).
    dbg(rid, "profile lookup with subscriptions failed, falling back:", e?.message || e);

    const lite =
      `${KLAVIYO_API}/profiles?` +
      `filter=${filter}` +
      `&fields[profile]=id,email,first_name,last_name`;

    const json = await fetchJson(lite, { headers: headers(key) }, { rid });
    const d = json?.data?.[0] || null;
    const id = d?.id || null;
    const firstName = d?.attributes?.first_name || null;
    const lastName  = d?.attributes?.last_name || null;

    dbg(rid, "profile lookup lite result", { id, status: null });
    return id ? { id, email, status: null, firstName, lastName } : null;
  }
}

/**
 * Create a profile if it doesn't exist. Returns profileId.
 */
async function ensureProfile(key, { email, firstName, lastName }, { rid }) {
  const existing = await getProfileByEmail(key, email, { rid });
  if (existing?.id) {
    dbg(rid, "profile exists", existing.id);
    return existing.id;
  }
  const body = {
    data: {
      type: "profile",
      attributes: {
        email,
        first_name: firstName || undefined,
        last_name: lastName || undefined,
      },
    },
  };
  dbg(rid, "create profile");
  const json = await fetchJson(`${KLAVIYO_API}/profiles`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  }, { rid });
  const createdId = json?.data?.id || null;
  dbg(rid, "created profile", createdId);
  return createdId;
}

/**
 * Patch profile traits/properties without changing subscription state.
 * (Safe to call even if you plan to skip (un)subscribe.)
 */
async function updateProfileTraits(key, profileId, {
  firstName,
  lastName,
  shop,
  countryCode,
  customerType,
}, { rid }) {
  if (!profileId) return;
  const body = {
    data: {
      type: "profile",
      id: profileId,
      attributes: {
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        // properties are custom traits that don't affect subscriptions
        properties: {
          shop: shop || undefined,
          country_code: countryCode || undefined,
          customer_type: customerType || undefined,
        },
        // (Optional) If you prefer formal location: { address1, city, region, country, zip }
        // location: countryCode ? { country: countryCode } : undefined,
      },
    },
  };
  dbg(rid, "PATCH /profiles/{id} traits");
  try {
    await fetchJson(`${KLAVIYO_API}/profiles/${profileId}`, {
      method: "PATCH",
      headers: headers(key),
      body: JSON.stringify(body),
    }, { rid });
  } catch (e) {
    dbg(rid, "traits patch failed (non-fatal):", e?.message || e);
  }
}

// -------- klaviyo list subscribe/unsubscribe helpers --------
async function subscribeProfiles(key, { listId, email, source, consent }, { rid }) {
  // Klaviyo bulk-create supports setting marketing consent state.
  // Consent metadata fields vary; we at least send consent state + custom_source.
  const body = {
    data: {
      type: "profile-subscription-bulk-create-job",
      attributes: {
        custom_source: source || "Checkout",
        profiles: {
          data: [
            {
              type: "profile",
              attributes: {
                email,
                subscriptions: {
                  email: {
                    marketing: {
                      consent: "SUBSCRIBED",
                    },
                  },
                },
              },
            },
          ],
        },
      },
      relationships: { list: { data: { type: "list", id: listId } } },
    },
  };
  dbg(rid, "POST profile-subscription-bulk-create-jobs");
  await fetchJson(`${KLAVIYO_API}/profile-subscription-bulk-create-jobs/`, {
    method: "POST", headers: headers(key), body: JSON.stringify(body)
  }, { rid });
}

async function unsubscribeProfiles(key, { listId, email, source }, { rid }) {
  const body = {
    data: {
      type: "profile-subscription-bulk-delete-job",
      attributes: { profiles: { data: [{ type: "profile", attributes: { email } }] } },
      relationships: { list: { data: { type: "list", id: listId } } }
    }
  };
  dbg(rid, "POST profile-subscription-bulk-delete-jobs");
  await fetchJson(`${KLAVIYO_API}/profile-subscription-bulk-delete-jobs/`, {
    method: "POST", headers: headers(key), body: JSON.stringify(body)
  }, { rid });
}

// -------- consent matrix lookup (country + customer_type) --------
function normCode(x){ return String(x||"").toUpperCase(); }
function normType(x){
  const s = String(x||"").toLowerCase();
  if (s === "single" || s === "first" || s === "first_time" || s === "first-time") return "single";
  if (s === "repeat" || s === "returning") return "repeat";
  return null;
}
function chooseRow(rows, code, customerType){
  const c = normCode(code);
  const t = normType(customerType);
  // matches on code fields we’ve seen used
  const codeMatch = (r) => [r.country_code, r.countryCode]
    .map(normCode).includes(c);
  const typeMatch = (r) => {
    const rt = normType(r.customer_type || r.customerType);
    if (!t && !rt) return true;              // neither specified
    if (!t && rt)  return false;             // row has type but caller doesn't
    if (t && !rt)  return true;              // row has no type → acts as default
    return rt === t;                          // both specified → must match
  };
  const candidates = rows.filter(codeMatch).filter(typeMatch);
  if (!candidates.length) return null;
  // prefer exact type match if available, else a row without type (default)
  const exact = candidates.find(r => normType(r.customer_type || r.customerType) === t);
  if (exact) return exact;
  const deflt = candidates.find(r => !normType(r.customer_type || r.customerType));
  return deflt || candidates[0];
}

async function resolveEmailMethodFromMatrix(countryCode, customerType, { rid }) {
  if (!countryCode) return null;

  // Prefer a helper if you’ve exposed one
  try {
    const mod = await import("~/services/consent-matrix.server");
    const fn = mod.getEmailMethodFor || mod.getEmailMethodForCountry || null;
    if (fn) {
      const v = (await fn(normCode(countryCode), normType(customerType))) || "";
      const u = v.toUpperCase();
      if (u === "SOI" || u === "DOI") { dbg(rid, "matrix helper", countryCode, customerType, u); return u; }
    }
  } catch { /* ignore */ }

  // Fallback: read the JSON directly
  try {
    const matrix = (await import("~/data/consent_matrix.json")).default;
    const row = chooseRow(matrix || [], countryCode, customerType);
    const method = String(row?.email_method || row?.emailMethod || "").toUpperCase();
    if (method === "SOI" || method === "DOI") {
      dbg(rid, "matrix json", countryCode, customerType, method);
      return method;
    }
  } catch { /* ignore */ }

  dbg(rid, "matrix not found", countryCode, customerType);
  return null;
}

/**
 * Sync a single customer to Klaviyo list(s).
 * @param {object} args
 * @param {string} args.shop
 * @param {string} args.email
 * @param {string=} args.firstName
 * @param {string=} args.lastName
 * @param {boolean=} args.subscribed
 * @param {"OPT_IN"|"OPT_OUT"|"NO_CHECKBOX"=} args.sessionMode
 * @param {string=} args.countryCode      // e.g. "GB"
 * @param {"single"|"repeat"} [args.customerType]
 * @param {object=} args.consentEvidence  // optional, but recommended
 *   // { explicitToggle?: boolean, doiConfirmed?: boolean, optInLevel?: "SINGLE_OPT_IN"|"CONFIRMED_OPT_IN",
 *   //   timestamp?: string, ip?: string, userAgent?: string, source?: string }
 */
export async function syncKlaviyoForCustomer(args) {
  const rid = randomUUID().slice(0, 8);
  const {
    shop,
    email,
    firstName,
    lastName,
    subscribed,
    sessionMode,
    countryCode,
    customerType,
    consentEvidence = {},
  } = args;

  dbg(rid, "sync start", { shop, email, subscribed, sessionMode, countryCode, customerType });
  if (!email) return;

  const settings = await prisma.klaviyoSettings.findUnique({ where: { shop } });
  if (!settings?.encryptedKey) { dbg(rid, "no klaviyo key → abort"); return; }

  const apiKey = dec(settings.encryptedKey);
  const singleList = settings.singleOptListId || null;
  const doubleList = settings.doubleOptListId || null;
  dbg(rid, "have key", mask(apiKey), { singleList, doubleList });

  // If we don't have a definite boolean, we don't touch subscription state
  if (typeof subscribed !== "boolean") { dbg(rid, "no subscribe state → abort"); return; }

  // Decide SOI/DOI via matrix (country + customer_type). If unknown, fallback to sessionMode.
  const method = await resolveEmailMethodFromMatrix(countryCode, customerType, { rid });
  let targetListId = null;
  if (subscribed) {
    if (method === "DOI")      targetListId = doubleList || singleList;
    else if (method === "SOI") targetListId = singleList || doubleList;
    else                       targetListId = sessionMode === "OPT_IN" ? (doubleList || singleList) : (singleList || doubleList);
    if (!targetListId) { dbg(rid, "no list configured → abort"); return; }
  }

  // Find or create the profile first
  let profile = await getProfileByEmail(apiKey, email, { rid });
  const profileId = profile?.id || await ensureProfile(apiKey, { email, firstName, lastName }, { rid });
  const currentStatus = profile?.status || "never_subscribed";

  // Keep traits in sync even if we skip list ops
  await updateProfileTraits(apiKey, profileId, {
    firstName,
    lastName,
    shop,
    countryCode,
    customerType,
  }, { rid });

  // Decide whether we have explicit consent strong enough to lift suppression
  const explicitConsent = !!(consentEvidence.explicitToggle || consentEvidence.doiConfirmed);
  const optInLevel = consentEvidence.optInLevel || (method === "DOI" ? "CONFIRMED_OPT_IN" : "SINGLE_OPT_IN");
  const consent = {
    timestamp: consentEvidence.timestamp || new Date().toISOString(),
    optInLevel,
  };

  try {
    const source =
      consentEvidence.source ||
      (sessionMode === "OPT_OUT" ? "Checkout (opt-out shown)" :
       sessionMode === "OPT_IN"  ? "Checkout (opt-in shown)"  :
                                   "Checkout (no checkbox)");

    if (subscribed) {
      // Already subscribed? No-op.
      if (currentStatus === "subscribed") {
        dbg(rid, "noop: already subscribed");
        return;
      }
      // Suppressed but no explicit consent? Skip.
      if (currentStatus === "suppressed" && !explicitConsent) {
        dbg(rid, "skip: suppressed profile without explicit consent");
        return;
      }

      // Subscribe to the target list (no immediate "cleanup" unsubscribe).
      await subscribeProfiles(apiKey, { listId: targetListId, email, source }, { rid });
      dbg(rid, "subscribed to", targetListId, "method:", method || "(fallback)", "status was:", currentStatus);

      // IMPORTANT: Do not bulk-delete from the "other" list here.
      // If you *must* enforce single-list membership, do it later in a delayed job
      // after verifying the profile shows as subscribed on the new list.
    } else {
      // Only when explicitly unsubscribing: remove from all configured lists.
      const all = [...new Set([singleList, doubleList].filter(Boolean))];
      for (const lid of all) {
        try { await unsubscribeProfiles(apiKey, { listId: lid, email, source: "Unsubscribe" }, { rid }); }
        catch (e) { dbg(rid, "unsubscribe failed", lid, e?.message || e); }
      }
    }
  } catch (e) {
    console.warn("[klaviyo]", rid, "sync failed", { shop, email, error: e?.message || String(e) });
  }
}
