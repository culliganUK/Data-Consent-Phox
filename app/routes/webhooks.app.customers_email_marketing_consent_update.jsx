// app/routes/webhooks.customers_email_marketing_consent_update.js
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { syncKlaviyoForCustomer } from "~/services/sync-to-klaviyo.server";

// --- small debug helper (enable with DEBUG_CONSENT_WEBHOOK=1)
const DBG = process.env.DEBUG_CONSENT_WEBHOOK === "1";
const dbg = (...args) => { if (DBG) console.log("[consent_webhook]", ...args); };

// Map Shopify -> our enum
function toState(raw) {
  const s = (raw || "").toString().toLowerCase();
  if (s === "subscribed") return "SUBSCRIBED";
  if (s === "unsubscribed") return "UNSUBSCRIBED";
  if (s === "not_subscribed") return "NOT_SUBSCRIBED";
  return "NOT_SUBSCRIBED";
}

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE") return new Response();

  const shopifyId = payload?.customer_id ? String(payload.customer_id) : null;
  const email = payload?.email_address ? String(payload.email_address).toLowerCase().trim() : null;

  const consent = payload?.email_marketing_consent || {};
  const state = toState(consent.state);
  const consentAt = consent?.consent_updated_at ? new Date(consent.consent_updated_at) : new Date();
  const optInLevel = consent?.opt_in_level || null;

  dbg("received", { shop, shopifyId, email, state, optInLevel });

  // --- find an existing Customer for suppression check (prefer ID, fall back to email)
  let existing = null;

  if (shopifyId) {
    existing = await prisma.customer.findFirst({
      where: { shop, shopifyCustomerId: shopifyId },
      select: {
        id: true,
        email: true,
        suppressConsentWebhookUntil: true,
        suppressConsentState: true,
      },
    });
  }
  if (!existing && email) {
    existing = await prisma.customer.findFirst({
      where: { shop, email },
      select: {
        id: true,
        email: true,
        suppressConsentWebhookUntil: true,
        suppressConsentState: true,
      },
    });
  }

  // 🔒 Suppression fence: if still within window AND same state → skip (clear fence)
  if (existing?.suppressConsentWebhookUntil && existing?.suppressConsentState) {
    const now = new Date();
    if (now <= existing.suppressConsentWebhookUntil && state === existing.suppressConsentState) {
      dbg("suppressed duplicate consent webhook", {
        id: existing.id,
        until: existing.suppressConsentWebhookUntil,
        state,
      });
      // Clear the fence after skipping so future legit changes process normally
      try {
        await prisma.customer.update({
          where: { id: existing.id },
          data: { suppressConsentWebhookUntil: null, suppressConsentState: null },
        });
      } catch {}
      return new Response();
    }
  }

  // --- upsert the Customer with latest consent (tri-state)
  let customerId;
  if (existing) {
    dbg("update customer", existing.id);
    const updated = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        email: email || undefined,
        shopifyCustomerId: shopifyId || undefined,
        lastState: state,
        lastConsentAt: consentAt,
        // Clear any lingering fence since this is a real change we’re honoring
        suppressConsentWebhookUntil: null,
        suppressConsentState: null,
      },
      select: { id: true },
    });
    customerId = updated.id;
  } else {
    dbg("create customer");
    const created = await prisma.customer.create({
      data: {
        shop,
        shopifyCustomerId: shopifyId,
        email,
        lastState: state,
        lastConsentAt: consentAt,
      },
      select: { id: true },
    });
    customerId = created.id;
  }

  // --- record an audit event with the tri-state
  await prisma.consentEvent.create({
    data: {
      customerId,
      type: "shopify_subscription_update",
      state, // ✅ tri-state enum on events
      note: JSON.stringify({
        source: "Shopify",
        raw: {
          state: consent?.state ?? null,
          opt_in_level: optInLevel,
          consent_updated_at: consent?.consent_updated_at ?? null,
        },
      }),
    },
  });

  // --- sync to Klaviyo (idempotent). Only if we have an email.
  if (email) {
    try {
      await syncKlaviyoForCustomer({
        shop,
        email,
        subscribed: state === "SUBSCRIBED",
        sessionMode: undefined,
        countryCode: undefined,
        customerType: undefined,
      });
    } catch (e) {
      // do not fail the webhook
      console.warn("[consent_webhook] klaviyo sync failed:", e?.message || e);
    }
  } else {
    dbg("skip Klaviyo sync: no email on payload/customer");
  }

  return new Response();
};
