// app/routes/api.settings.privacy.jsx
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { authenticate } from "~/shopify.server";
import { countryFromIp } from "~/utils/geo.server.js";
import { randomUUID } from "crypto";

function getClientIp(headers) {
  const raw =
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    headers.get("x-client-ip") ||
    headers.get("fastly-client-ip") ||
    headers.get("fly-client-ip") ||
    "";
  return raw.split(",")[0].trim().replace(/^::ffff:/, "") || null;
}

// Normalize "dest" → "mystore.myshopify.com"
function shopFromDest(dest) {
  if (!dest) return "";
  try {
    return new URL(dest).host;
  } catch (_) {
    return String(dest).replace(/^https?:\/\//, "");
  }
}

export async function loader({ request }) {
  const { cors, sessionToken } = await authenticate.public.checkout(request, {
    corsHeaders: ["Authorization", "X-Checkout-Token", "X-Customer-Email"],
    allowMethods: ["GET", "OPTIONS"],
  });

  const { pickRule } = await import("~/services/consent-matrix.server");

  const shop = shopFromDest(sessionToken.dest);
  const checkoutToken = request.headers.get("x-checkout-token") || null;
  const emailHeader = request.headers.get("x-customer-email");
  const email = emailHeader ? String(emailHeader).toLowerCase().trim() : null;

  const ip = getClientIp(request.headers);
  const countryCode = countryFromIp(ip) ?? "GB";

  const rule = await pickRule({
    code: countryCode
  });

   // Optional lookup: are they currently unsubscribed in your DB?
  let currentState = null;
  if (email) {
    const existing = await prisma.customer.findFirst({
      where: { shop, email },
      select: { lastState: true },
    });
    currentState = existing?.lastState || null; // "SUBSCRIBED" | "UNSUBSCRIBED" | "NOT_SUBSCRIBED" | null
  }

  // --- Load settings from DB ---
  const settings = await prisma.appSettings.findUnique({
    where: { shop: shop }
  });

  // Safe fallbacks if settings are missing
  const optInText =
    settings?.optInText ??
    'We would like to email you news, special offers and other promotional material that may be of interest to you. Tick the box to <b>opt in</b>.';
  const optOutText =
    settings?.optOutText ??
    'We would like to email you news, special offers and other promotional material that may be of interest to you. Tick the box to <b>opt out.</b>';
  const noCheckboxText =
    settings?.noCheckboxText ??
    "";
  const marketingPreferences = settings?.marketingInfo ?? "";
  const privacyUrl = settings?.privacyUrl ?? "";

  // Determine consent mode by country and previously unsubscribed status
  const baseMode = rule?.widget || "OPT_IN";
  const mode = currentState === "UNSUBSCRIBED" ? "OPT_IN" : baseMode;

  // Pick display text from DB according to mode
  const displayText =
    mode === "OPT_IN" ? optInText : mode === "OPT_OUT" ? optOutText : noCheckboxText;

  // Persist/refresh a consent session if a checkout token is present
  let sessionId = null;
  if (checkoutToken) {
    const session = await prisma.consentSession.upsert({
      where: { checkoutToken },
      create: {
        id: randomUUID(),
        shop,
        checkoutToken,
        mode,
        displayText,
        privacyUrl,
        marketingPreferences,
        country: countryCode,
        ipCountry: countryCode,
      },
      update: {
        mode,
        displayText,
        privacyUrl,
        marketingPreferences,
        country: countryCode,
        ipCountry: countryCode,
      },
      select: { id: true },
    });
    sessionId = session.id;
  }

  return cors(
    json(
      {
        sessionId,
        storeDomain: shop,
        countryCode,
        mode,                     // OPT_IN | OPT_OUT | NO_CHECKBOX
        displayText,
        marketingPreferences,
        privacyUrl,
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    )
  );
}

// OPTIONS: preflight (triggered because we send Authorization header)
export async function action({ request }) {
  const { cors } = await authenticate.public.checkout(request, {
    corsHeaders: ["Authorization", "X-Checkout-Token"],
    allowMethods: ["GET", "OPTIONS"],
  });

  if (request.method === "OPTIONS") {
    return cors(json({}, { status: 200 }));
  }
  return cors(json({ error: "Method Not Allowed" }, { status: 405 }));
}
