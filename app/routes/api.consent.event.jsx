// app/routes/api.consent.event.js
import { json } from "@remix-run/node";
import { prisma } from "../../app/db.server";
import { authenticate } from "../../app/shopify.server";

// Build correct CORS headers for the caller
function corsHeadersFrom(request) {
  const origin = request.headers.get("Origin") || "*";
  const reqHdrs =
    request.headers.get("Access-Control-Request-Headers") ||
    "Authorization, Content-Type, X-Checkout-Token";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHdrs,
    "Access-Control-Max-Age": "600",
    // helps caches/proxies pick per-origin variants
    Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
  };
}

// ✅ Remix sends preflight (OPTIONS) to the loader. Answer it without auth.
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeadersFrom(request) });
  }
  // Any accidental GETs get a friendly 405 with CORS
  return new Response(null, { status: 405, headers: corsHeadersFrom(request) });
}

export async function action({ request }) {

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeadersFrom(request) });
  }

  const { cors, sessionToken } = await authenticate.public.checkout(request, {
    corsHeaders: ["Authorization", "Content-Type", "X-Checkout-Token"],
    allowMethods: ["POST", "OPTIONS"],
  });

  // Preflight
  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  // Parse JSON body
  let body;
  try {
    body = await request.json();
  } catch {
    return cors(json({ error: "Invalid JSON" }, { status: 400 }));
  }

  const { sessionId, type, state, country, note } = body || {};
  if (!sessionId || !type) {
    return cors(json({ error: "Missing sessionId or type" }, { status: 400 }));
  }

  // Normalize "dest" → "mystore.myshopify.com"
  const shop = (() => {
    const dest = sessionToken?.dest || "";
    try { return new URL(dest).host; } catch { return String(dest).replace(/^https?:\/\//, ""); }
  })();

  // Optional: read the checkout token header if you want it in your audit
  const checkoutToken = request.headers.get("x-checkout-token") || null;

  const evt = await prisma.consentEvent.create({
    data: {
      sessionId,
      type,
      state,
      country: country ?? null,
      note: note ?? null
    },
    select: { sessionId: true },
  });

  try {
    await prisma.consentSession.update({
      where: { id: evt.sessionId },
      data: {}, // just to bump updatedAt via @updatedAt
    });
  } catch {
    // No-op: the session will be created elsewhere (e.g., /api/settings/privacy or /start)
  }

  return cors(
    json(
      { ok: true, shop, checkoutTokenPresent: Boolean(checkoutToken) },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    )
  );
}
