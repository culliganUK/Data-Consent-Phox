// app/routes/webhooks.orders-create.js
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { syncKlaviyoForCustomer } from "~/services/sync-to-klaviyo.server";

// --- small debug helper
const DBG = process.env.DEBUG_ORDERS_WEBHOOK === "1";
const dbg = (...args) => { if (DBG) console.log("[orders_webhook]", ...args); };

// Map subscribe boolean → tri-state enum
function toStateFromSubscribe(subscribe) {
  if (subscribe === true) return "SUBSCRIBED";
  if (subscribe === false) return "UNSUBSCRIBED";
  return "NOT_SUBSCRIBED";
}

// Resolve customer's order count and type (single/repeat)
async function resolveCustomerType(admin, payload) {
  // 1) If webhook payload has orders_count, trust it
  if (typeof payload?.customer?.orders_count === "number") {
    const count = payload.customer.orders_count;
    // NOTE: In orders/create, this count includes the order that just got created.
    return { count, type: count > 1 ? "repeat" : "single" };
  }

  // 2) Try Admin GraphQL for canonical numberOfOrders
  const numericId = payload?.customer?.id ? String(payload.customer.id) : null;
  if (numericId) {
    try {
      const customerGid = `gid://shopify/Customer/${numericId}`;
      const Q = `#graphql
        query($id: ID!) {
          customer(id: $id) {
            numberOfOrders
          }
        }
      `;
      const resp = await admin.graphql(Q, { variables: { id: customerGid } });
      const json = await resp.json();
      const raw = json?.data?.customer?.numberOfOrders;
      const n = raw == null ? null : Number(raw);
      if (typeof n === "number") {
        return { count: n, type: n > 1 ? "repeat" : "single" };
      }
    } catch (e) {
      console.warn("[orders] numberOfOrders fetch failed:", e?.message || e);
    }
  }

  // 3) Unknown: guest checkout or lookup failed
  dbg("numberOfOrders_by_admin - unknown");
  return { count: null, type: null };
}

async function setConsentWebhookSuppression(customerId, state, minutes = 5) {
  const until = new Date(Date.now() + minutes * 60 * 1000);
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      suppressConsentWebhookUntil: until,
      suppressConsentState: state,
    },
  });
}

async function clearConsentWebhookSuppression(customerId) {
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      suppressConsentWebhookUntil: null,
      suppressConsentState: null,
    },
  });
}

const EMAIL_MUT = `#graphql
mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
  customerEmailMarketingConsentUpdate(input: $input) {
    userErrors { field message }
    customer {
      id
      email
      emailMarketingConsent {
        marketingState
        marketingOptInLevel
        consentUpdatedAt
      }
    }
  }
}`;

const CUSTOMER_UPDATE = `#graphql
mutation customerUpdate($input: CustomerInput!) {
  customerUpdate(input: $input) {
    userErrors { field message }
    customer { id email }
  }
}`;

export async function action({ request }) {
  const { topic, admin, payload, shop } = await authenticate.webhook(request);
  if (topic !== "ORDERS_CREATE") return json({ ok: true });

  // Pull our session id from order attributes
  const attrs = payload.note_attributes || [];
  const getAttr = (n) => (attrs.find((a) => a.name === n) || {}).value || "";
  const sessionId = getAttr("consent_session_id") || getAttr("consent_uuid") || null;

  // Load session + latest toggle (NOTE: read tri-state from `state`)
  const session = sessionId
    ? await prisma.consentSession.findUnique({ where: { id: sessionId } })
    : null;

  const latestToggle = sessionId
    ? await prisma.consentEvent.findFirst({
        where: { sessionId, type: "shopify_checkout_toggle" },
        orderBy: { createdAt: "desc" },
        select: { state: true }
      })
    : null;

  // Decide final subscribe boolean (keep boolean for internal logic)
  let subscribe;
  if (latestToggle?.state) {
    // Treat NOT_SUBSCRIBED as false (i.e., not subscribed)
    subscribe = latestToggle.state === "SUBSCRIBED";
  } else if (session) {
    if (session.mode === "OPT_OUT" || session.mode === "NO_CHECKBOX") subscribe = true;
    else if (session.mode === "OPT_IN") subscribe = false;
    else subscribe = undefined;
  } else {
    subscribe = undefined; // no session evidence; do not guess
  }

  const resolvedState = toStateFromSubscribe(subscribe);
  dbg("resolved", { sessionId, subscribe, resolvedState });

  // Resolve identifiers
  const orderId = String(payload.id);
  const email = (payload.email || payload.customer?.email || "").trim().toLowerCase() || null;
  const firstName = (payload.customer?.first_name || "").trim() || null;
  const lastName  = (payload.customer?.last_name || "").trim() || null;
  const billingCountry =
    payload?.billing_address?.country_code ||
    payload?.billing_address?.country ||
    null;

  const { count: ordersCount, type: customerType } = await resolveCustomerType(admin, payload);
  const numericCustomerId = payload.customer?.id ? String(payload.customer.id) : null;
  const customerGid = numericCustomerId
    ? `gid://shopify/Customer/${numericCustomerId}`
    : null;

  dbg("ordersCount", { ordersCount, customerType });

  // --- CHANGE #1: Look up existing record to compare lastState (for Klaviyo idempotency)
  const existing = email
    ? await prisma.customer.findUnique({
        where: { shop_email: { shop, email } },
        select: { id: true, lastState: true },
      })
    : null;

  // Upsert Customer by (shop, email)
  let customerRow = null;
  if (email) {
    const patch =
      typeof subscribe === "undefined"
        ? {} // don't touch lastState if we don't actually know
        : {
            lastState: resolvedState,            // <-- tri-state
            lastConsentAt: new Date(),
            lastMode: session?.mode || undefined,
            lastCountry:
              session?.country || session?.ipCountry || session?.billingCountry || undefined,
          };

    customerRow = await prisma.customer.upsert({
      where: { shop_email: { shop, email } },
      update: {
        email: email || undefined,
        firstName,
        lastName,
        shopifyCustomerId: numericCustomerId || undefined,
        ...patch,
      },
      create: {
        shop,
        email: email || null,
        firstName,
        lastName,
        shopifyCustomerId: numericCustomerId || null,
        ...patch,
      },
      select: { id: true },
    });

    // --- CHANGE #2: Only sync to Klaviyo if the resolved state actually changed
    const stateKnown = typeof subscribe !== "undefined";
    const stateChanged = stateKnown && existing?.lastState !== resolvedState;

    if (stateChanged) {
      try {
        await syncKlaviyoForCustomer({
          shop,
          email,
          firstName,
          lastName,
          subscribed: subscribe,
          sessionMode: session?.mode || undefined,
          countryCode: session?.billingCountry || session?.ipCountry || billingCountry || null,
          customerType
        });
      } catch (e) {
        console.warn("[klaviyo sync] failed", e?.message || e);
      }
    } else {
      dbg("skip Klaviyo sync (unknown subscribe or no state change)", {
        stateKnown,
        previous: existing?.lastState ?? null,
        next: resolvedState,
      });
    }
  }

  // Update Shopify customer consent **only** if we know the outcome and have a Shopify customer
  if (customerGid && typeof subscribe === "boolean") {
    // Set suppression *before* calling Shopify to cover race with webhook arrival
    if (customerRow?.id) {
      await setConsentWebhookSuppression(customerRow.id, resolvedState, 2); // 2-minute fence
    }

    const now = new Date().toISOString();

    const vars = {
      input: {
        customerId: customerGid,
        emailMarketingConsent: {
          marketingState: subscribe ? "SUBSCRIBED" : "UNSUBSCRIBED", // Shopify API expects these two
          marketingOptInLevel: "SINGLE_OPT_IN",   // or CONFIRMED_OPT_IN if you run DOI
          consentUpdatedAt: now,
        },
      },
    };

    try {
      const resp = await admin.graphql(EMAIL_MUT, { variables: vars });
      const json = await resp.json();

      const errs = json?.data?.customerEmailMarketingConsentUpdate?.userErrors || [];
      if (errs.length) {
        const needsEmail =
          errs.some(e => (e.message || "").toLowerCase().includes("unique email"));
        if (needsEmail && email) {
          // try to set the email, then retry once
          const upd = await admin.graphql(CUSTOMER_UPDATE, {
            variables: { input: { id: customerGid, email } },
          });
          const updJson = await upd.json();
          const updErrs = updJson?.data?.customerUpdate?.userErrors || [];
          if (!updErrs.length) {
            const retry = await admin.graphql(EMAIL_MUT, { variables: vars });
            const retryJson = await retry.json();
            const retryErrs = retryJson?.data?.customerEmailMarketingConsentUpdate?.userErrors || [];
            if (retryErrs.length) console.warn("consent retry userErrors", retryErrs);
          } else {
            console.warn("customerUpdate userErrors", updErrs);
          }
        } else {
          console.warn("customerEmailMarketingConsentUpdate userErrors", errs);
        }
        if (customerRow?.id) await clearConsentWebhookSuppression(customerRow.id);
      }
    } catch (e) {
      try {
        const text = await e?.response?.text?.();
        console.error("Consent update failed:", e?.message || e, text || "");
      } catch {
        console.error("Consent update failed:", e);
      }
      if (customerRow?.id) await clearConsentWebhookSuppression(customerRow.id);
    }
  } else {
    dbg("skip Shopify consent update (unknown subscribe or no customerGid)", {
      hasGid: !!customerGid, subscribeType: typeof subscribe,
    });
  }

  // Link session + write finalise event; backfill events → customer
  if (sessionId) {
    try {
      await prisma.consentSession.update({
        where: { id: sessionId },
        data: {
          shop,
          orderId,
          billingCountry,
          customerId: customerRow?.id || null,
          subscribed: typeof subscribe === "boolean" ? subscribe : null, // keep historical boolean
          consentAt: typeof subscribe === "boolean" ? new Date() : null,
        },
      });
    } catch (e) {
      dbg("session update failed (non-fatal)", e?.message || e);
    }

    // backfill prior session events with customerId
    if (customerRow?.id) {
      await prisma.consentEvent.updateMany({
        where: { sessionId, customerId: null },
        data: { customerId: customerRow.id },
      });
    }

    await prisma.consentEvent.create({
      data: {
        sessionId,
        customerId: customerRow?.id || null,
        type: "shopify_checkout",
        state: resolvedState,
        note: JSON.stringify({
          source: "Shopify",
          sessionMode: session?.mode || null,
          billingCountry,
        }),
      },
    });
  }

  return json({ ok: true });
}
