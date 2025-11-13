#!/usr/bin/env node
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// --- CLI args
const args = process.argv.slice(2);
const getFlag = (name) => args.some((a) => a === `--${name}`);
const getArg = (name) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=")[1] : null;
};

const SHOP = getArg("shop") || process.env.SHOP_DOMAIN;
const PUSH_KLAVIYO = getFlag("push-klaviyo");
const DRY_RUN = getFlag("dry-run");
const BATCH = 250;

// lazy import helper only if requested
let syncKlaviyoForCustomer = null;

// --- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Map Shopify emailMarketingConsent.marketingState to our DB state:
 * Shopify can be: SUBSCRIBED | UNSUBSCRIBED | NOT_SUBSCRIBED | null
 * We keep all three states; null → NOT_SUBSCRIBED for clarity.
 */
function mapState(s) {
  if (s === "SUBSCRIBED") return "SUBSCRIBED";
  if (s === "UNSUBSCRIBED") return "UNSUBSCRIBED";
  if (s === "NOT_SUBSCRIBED") return "NOT_SUBSCRIBED";
  return "NOT_SUBSCRIBED"; // fallback for null/unknown
}

function gidToNumeric(gid) {
  if (!gid) return null;
  const parts = String(gid).split("/");
  return parts.at(-1) || null;
}

async function getOfflineToken(shop) {
  const sess = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { id: "desc" }, // use id for recency (no createdAt on your Session model)
    select: { accessToken: true },
  });
  return sess?.accessToken || null;
}

async function adminGraphQL(shop, token, query, variables) {
  const url = `https://${shop}/admin/api/2024-10/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify ${res.status} ${res.statusText}: ${text}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`Shopify GQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const CUSTOMERS_QUERY = `
  query Customers($after: String) {
    customers(first: ${BATCH}, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        email
        firstName
        lastName
        updatedAt
        defaultAddress { countryCodeV2 }
        emailMarketingConsent { marketingState consentUpdatedAt }
      }
    }
  }
`;

async function upsertOne(shop, node) {
  const shopifyCustomerId = gidToNumeric(node.id);
  const email = node.email ? node.email.trim().toLowerCase() : null;
  const firstName = node.firstName || null;
  const lastName = node.lastName || null;

  const rawState = node.emailMarketingConsent?.marketingState || 'NOT_SUBSCRIBED';
  const marketingState = mapState(rawState);
  const consentUpdatedAt = node.emailMarketingConsent?.consentUpdatedAt
    ? new Date(node.emailMarketingConsent.consentUpdatedAt)
    : node.updatedAt
    ? new Date(node.updatedAt)
    : new Date();
  const lastCountry = node.defaultAddress?.countryCodeV2 || null;

  const existing =
    (await prisma.customer.findFirst({
      where: { shop, shopifyCustomerId },
      select: { id: true },
    })) ||
    (email
      ? await prisma.customer.findFirst({
          where: { shop, email },
          select: { id: true },
        })
      : null);

  const dataPatch = {
    shop,
    email,
    firstName,
    lastName,
    shopifyCustomerId,
    lastState: marketingState,
    lastConsentAt: consentUpdatedAt,
    lastCountry,
  };

  let id = existing?.id || null;
  if (DRY_RUN) {
    console.log(`[dry-run] ${existing ? "update" : "create"}`, {
      email,
      shopifyCustomerId,
      marketingState,
    });
  } else if (existing) {
    const r = await prisma.customer.update({
      where: { id: existing.id },
      data: dataPatch,
      select: { id: true },
    });
    id = r.id;
  } else {
    const r = await prisma.customer.create({
      data: dataPatch,
      select: { id: true },
    });
    id = r.id;
  }

  if (!DRY_RUN && id) {
    await prisma.consentEvent.create({
      data: {
        customerId: id,
        type: "shopify_sync",
        state: marketingState,
        note: JSON.stringify({
          source: "Shopify",
          shopifyMarketingState: rawState,
          normalizedState: marketingState,
          consentUpdatedAt: node.emailMarketingConsent?.consentUpdatedAt || null,
          shopifyCustomerId,
        }),
      },
    });
  }

  return {
    id,
    email,
    firstName,
    lastName,
    subscribed: marketingState === "SUBSCRIBED",
  };
}

async function main() {
  if (!SHOP) {
    console.error("❌ Provide --shop=my-shop.myshopify.com or set SHOP_DOMAIN in env.");
    process.exit(1);
  }

  const token = await getOfflineToken(SHOP);
  if (!token) {
    console.error(`❌ No offline session token found for ${SHOP}. Reinstall app or store token.`);
    process.exit(1);
  }

  if (PUSH_KLAVIYO) {
    const mod = await import(new URL("../app/services/sync-to-klaviyo.server.js", import.meta.url));
    syncKlaviyoForCustomer = mod.syncKlaviyoForCustomer;
  }

  console.log(`▶️  Starting sync for ${SHOP} (batch=${BATCH}) ${DRY_RUN ? "[DRY RUN]" : ""}`);
  let after = null;
  let total = 0;
  let page = 0;

  while (true) {
    page += 1;
    const data = await adminGraphQL(SHOP, token, CUSTOMERS_QUERY, { after });
    const { nodes, pageInfo } = data.customers;
    console.log(`— Page ${page}: ${nodes.length} customers`);

    for (const node of nodes) {
      try {
        const res = await upsertOne(SHOP, node);
        total += 1;

        if (PUSH_KLAVIYO && res?.email) {
          try {
            await syncKlaviyoForCustomer({
              shop: SHOP,
              email: res.email,
              firstName: res.firstName,
              lastName: res.lastName,
              subscribed: res.subscribed, // still boolean for sync helper
              // sessionMode unknown; helper will pick default list
            });
          } catch (e) {
            console.warn("[klaviyo bulk]", res.email, e?.message || e);
          }
          await sleep(80);
        }
      } catch (e) {
        console.warn("  ⚠️  upsert failed:", node.email, e?.message || e);
      }
    }

    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
    await sleep(250);
  }

  console.log(`✅ Done. Synced ${total} customers.`);
}

main()
  .catch((e) => {
    console.error("❌ Sync failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
