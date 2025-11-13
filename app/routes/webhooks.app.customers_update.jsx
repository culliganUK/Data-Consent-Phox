// app/routes/webhooks.customers-update.js
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

// Prefer the modern consent object; fall back to accepts_marketing
function resolveMarketingState(payload) {
  const raw = payload?.email_marketing_consent?.state;
  if (raw) {
    const s = String(raw).toUpperCase().replace(/[\s-]/g, "_");
    if (s === "SUBSCRIBED") return "SUBSCRIBED";
    if (s === "UNSUBSCRIBED") return "UNSUBSCRIBED";
    if (s === "NOT_SUBSCRIBED") return "NOT_SUBSCRIBED";
  }
  if (typeof payload?.accepts_marketing === "boolean") {
    return payload.accepts_marketing ? "SUBSCRIBED" : "NOT_SUBSCRIBED";
  }
  return null; // unknown → caller will fallback to NOT_SUBSCRIBED
}

function resolveConsentUpdatedAt(payload) {
  const ts = payload?.email_marketing_consent?.consent_updated_at;
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.valueOf())) return d;
  }
  return new Date(); // sensible default for first write
}

export async function action({ request }) {
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "CUSTOMERS_UPDATE") return new Response();

  const shopifyId = payload?.id ? String(payload.id) : null;
  if (!shopifyId) return new Response(); // nothing to link

  const nextEmail = payload?.email ? String(payload.email).toLowerCase().trim() : null;
  const nextFirst = payload?.first_name || null;
  const nextLast  = payload?.last_name || null;

  // Load current (we key by composite unique: (shop, shopifyCustomerId))
  const current = await prisma.customer.findFirst({
    where: { shop, shopifyCustomerId: shopifyId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  // Compute changed fields for a tiny audit note
  const changed = [];
  const patch = {};
  if (!current || current.email !== nextEmail) {
    patch.email = nextEmail;
    changed.push("email");
  }
  if (!current || current.firstName !== nextFirst) {
    patch.firstName = nextFirst;
    changed.push("first name");
  }
  if (!current || current.lastName !== nextLast) {
    patch.lastName = nextLast;
    changed.push("last name");
  }

  // Resolve marketing state/time for CREATE only
  const incomingState = resolveMarketingState(payload); // may be null
  const incomingConsentAt = resolveConsentUpdatedAt(payload);

  const customer = await prisma.customer.upsert({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyId } },
    update: patch, // 🔒 do not touch lastState/lastConsentAt on updates
    create: {
      shop,
      shopifyCustomerId: shopifyId,
      email: nextEmail,
      firstName: nextFirst,
      lastName: nextLast,
      // ✅ Use payload’s state if present; else fallback to NOT_SUBSCRIBED
      lastState: incomingState ?? "NOT_SUBSCRIBED",
      lastConsentAt: incomingConsentAt,
    },
    select: { id: true },
  });

  // Record an event only if something actually changed (skip on pure create if you like)
  if (changed.length /* && current */) {
    await prisma.consentEvent.create({
      data: {
        customerId: customer.id,
        type: "shopify_profile_update",
        note: `${changed.join(", ")}`,
      },
    });
  }

  return new Response();
}
