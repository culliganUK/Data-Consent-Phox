// app/routes/app.customers.$id.jsx
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import {
  Page, Card, Text, Badge, BlockStack, InlineStack, Box, Divider,
  Collapsible, DescriptionList, Link, Button, Icon, Modal,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";

export async function loader({ request, params }) {
  await authenticate.admin(request);
  const id = params.id;

  const customer = await prisma.customer.findUnique({
    where: { id },
    select: {
      id: true, shop: true, email: true, firstName: true, lastName: true,
      shopifyCustomerId: true, lastState: true, lastConsentAt: true, lastCountry: true,
    },
  });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  const events = await prisma.consentEvent.findMany({
    where: { customerId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true, createdAt: true, type: true, state: true, note: true, country: true,
      sessionId: true,
      session: {
        select: {
          id: true, mode: true, consentAt: true, orderId: true,
          ipCountry: true, billingCountry: true, displayText: true, privacyUrl: true, marketingPreferences: true,
        },
      },
    },
  });

  const { getCountryNameFromMatrix } = await import("~/services/consent-matrix.server");

  const codes = new Set();
  if (customer.lastCountry) codes.add(customer.lastCountry);
  for (const ev of events) {
    if (ev.country) codes.add(ev.country);
    if (ev.session?.ipCountry) codes.add(ev.session.ipCountry);
    if (ev.session?.billingCountry) codes.add(ev.session.billingCountry);
  }

  const codeToName = {};
  for (const c of codes) {
    const name = getCountryNameFromMatrix(c);
    if (name) codeToName[String(c).toUpperCase()] = name;
  }

  return json({ customer, events, codeToName });
}

function formatDate(d) {
  try { return new Date(d).toLocaleString(); } catch { return "—"; }
}

function prettyMode(mode) {
  if (mode === "OPT_OUT") return "Opt Out checkbox - Email";
  if (mode === "OPT_IN") return "Opt In checkbox - Email";
  if (mode === "NO_CHECKBOX") return "No checkbox - Email";
  return "—";
}

function actionLabel(type) {
  switch (type) {
    case "shopify_profile_update": return "Profile update";
    case "shopify_checkout_toggle": return "Consent toggled";
    case "shopify_checkout": return "Checkout completed";
    case "shopify_subscription_update": return "Consent update";
    case "shopify_sync": return "Shopify sync";
    default: return type || "—";
  }
}

function parseMeta(note) {
  if (!note) return null;
  try {
    const j = JSON.parse(note);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

// Simple HTML → text for showing marketing copy in the modal
function stripTags(html = "") {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Polaris Badge for an outcome
function getStateLabelTone(state) {
  const s = (state || "").toUpperCase();
  if (s === "SUBSCRIBED") return { label: "Subscribed", tone: "success" };
  if (s === "UNSUBSCRIBED") return { label: "Unsubscribed", tone: "attention" };
  if (s === "NOT_SUBSCRIBED") return { label: "Not subscribed", tone: "" };
  return { label: "—", tone: "subdued" };
}

// 🔎 Rationale builder: explains *why* the outcome happened
function rationaleForEvent(ev) {
  const mode = ev.session?.mode; // "OPT_IN" | "OPT_OUT" | "NO_CHECKBOX" | undefined
  const state = ev.state;

  switch (ev.type) {
    case "shopify_checkout_toggle": {
      if (mode === "OPT_IN") {
        return state === 'SUBSCRIBED'
          ? "Customer checked the opt-in box during checkout."
          : "Customer unchecked or did not check the opt-in box during checkout.";
      }
      if (mode === "OPT_OUT") {
        return state === 'UNSUBSCRIBED' || state === 'NOT_SUBSCRIBED'
          ? "Customer ticked the opt-out box to unsubscribe during checkout."
          : "Customer left the opt-out box unchecked (no opt-out action).";
      }
      if (mode === "NO_CHECKBOX") {
        return "No checkbox was shown; toggle recorded for telemetry only.";
      }
      return "Consent UI mode unknown during toggle.";
    }

    case "shopify_checkout": {
      if (mode === "OPT_IN") {
        return state === 'SUBSCRIBED'
          ? "Opt-in checkbox was shown and the customer opted in."
          : "Opt-in checkbox was shown and the customer did not opt in.";
      }
      if (mode === "OPT_OUT") {
        return state === 'SUBSCRIBED'
          ? "Opt-out checkbox was shown; the customer did not opt out (soft opt-in)."
          : "Opt-out checkbox was shown; the customer opted out.";
      }
      if (mode === "NO_CHECKBOX") {
        return state === 'SUBSCRIBED'
          ? "No checkbox was shown. The customer was subscribed via implicit/soft opt-in."
          : "No checkbox was shown. The subscription remained off (e.g., prior unsubscribe or suppression).";
      }
      return "Checkout completed; consent mode unknown.";
    }

    case "shopify_subscription_update": {
      if (state === "SUBSCRIBED") {
        return `Subscription was set to subscribed.`;
      }
      if (state === "UNSUBSCRIBED") {
        return `Subscription was set to unsubscribed.`;
      }
      if (state === "NOT_SUBSCRIBED") {
        return `Subscription was set to not subscribed.`;
      }
      return "Subscription state was changed in Shopify.";
    }

    case "shopify_profile_update":
      return "Customer profile fields were edited in Shopify.";

    case "shopify_sync":
      return "Data was synced from Shopify.";

    default:
      return "Outcome not captured for this event.";
  }
}

export default function CustomerDetail() {
  const { customer, events, codeToName } = useLoaderData();

  // small helper for client rendering
  const countryLabel = (code) => {
    if (!code) return "—";
    const up = String(code).toUpperCase();
    return codeToName?.[up] || up;
  };

  const fullName = useMemo(
    () => [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "—",
    [customer.firstName, customer.lastName]
  );

  const [open, setOpen] = useState(() => ({}));
  const toggle = (id) => setOpen((s) => ({ ...s, [id]: !s[id] }));

  // Modal state for “Marketing information”
  const [mktModal, setMktModal] = useState({ open: false, title: "", content: "" });
  const openMarketing = (title, html) => setMktModal({ open: true, title, content: html || "" });
  const closeMarketing = () => setMktModal((m) => ({ ...m, open: false }));
  const { label: statusLabel, tone: statusTone } = getStateLabelTone(customer.lastState);

  const handleViewCustomerClick = () => {
    shopify.intents.invoke('edit:shopify/Customer', {
      value: `gid://shopify/Customer/${customer.shopifyCustomerId}`
    });
  };

  return (
    <Page
      title={fullName !== "—" ? fullName : (customer.email || customer.id)}
      backAction={{ content: "Customers", url: "/app/customers" }}
      subtitle={customer.email}
      titleMetadata={
        statusLabel !== "—" ? <Badge tone={statusTone}>{statusLabel}</Badge> : null
      }
      secondaryActions={
        <Button onClick={handleViewCustomerClick}>View customer</Button>
      }
    >
      <Box paddingBlockEnd={800}>
        <BlockStack gap="400">
          {/* Events */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Events</Text>
              <Box>
                {events.length === 0 ? (
                  <Text tone="subdued">No events yet.</Text>
                ) : (
                  events.map((ev, idx) => {
                    const openState = !!open[ev.id];
                    const meta = parseMeta(ev.note);

                    let items;
                    if (ev.type === "shopify_profile_update") {
                      items = [
                        { term: "Action", description: "Profile update" },
                        { term: "Source", description: "Shopify" },
                        { term: "Timestamp", description: formatDate(ev.createdAt) },
                        { term: "Changed", description: meta?.note || ev.note || "—" },
                        { term: "Rationale", description: rationaleForEvent(ev) },
                      ];
                    } else if (ev.type === "shopify_subscription_update") {
                      const { label: statusLabel, tone: statusTone } = getStateLabelTone(ev.state);
                      items = [
                        { term: "Action", description: "Consent update" },
                        { term: "Source", description: meta?.source || "Shopify" },
                        { term: "Outcome", description: <Badge tone={statusTone}>{statusLabel}</Badge> },
                        { term: "Timestamp", description: formatDate(ev.createdAt) },
                        { term: "Rationale", description: rationaleForEvent(ev) },
                      ];
                    } else if (ev.type === "shopify_checkout") {
                      const { label: statusLabel, tone: statusTone } = getStateLabelTone(ev.state)
                      items = [
                        { term: "Action", description: actionLabel(ev.type) },
                        { term: "Source", description: meta?.source || "Shopify" },
                        { term: "Order Id", description: ev.session?.orderId || "—" },
                        { term: "Session Id", description: ev.sessionId || "—" },
                        { term: "Outcome", description: <Badge tone={statusTone}>{statusLabel}</Badge> },
                        { term: "Timestamp", description: formatDate(ev.createdAt) },
                        { term: "IP Country", description: countryLabel(ev.session?.ipCountry) || "—" },
                        { term: "Billing Country", description: countryLabel(ev.session?.billingCountry) || "—" },
                        {
                          term: "Checkbox Configuration",
                          description: (() => {
                            const label = prettyMode(ev.session?.mode);
                            return ev.session?.variant ? `${label} (${ev.session.variant})` : label;
                          })(),
                        },
                        {
                          term: "Display Text",
                          description: ev.session?.displayText ? (
                            <Button
                              variant="plain"
                              onClick={() =>
                                openMarketing(
                                  `Marketing information (session ${ev.session?.id || ""})`,
                                  ev.session.displayText
                                )
                              }
                            >
                              Click here to view
                            </Button>
                          ) : "—",
                        },
                        {
                          term: "Marteting information",
                          description: ev.session?.marketingPreferences ? (
                            <Button
                              variant="plain"
                              onClick={() =>
                                openMarketing(
                                  `Marketing information (session ${ev.session?.id || ""})`,
                                  ev.session.marketingPreferences
                                )
                              }
                            >
                              Click here to view
                            </Button>
                          ) : "—",
                        },
                        {
                          term: "Privacy Policy",
                          description: ev.session?.privacyUrl ? (
                            <Link url={ev.session?.privacyUrl} target="_blank" removeUnderline>
                              {ev.session.privacyUrl}
                            </Link>
                          ) : "—",
                        },
                        { term: "Rationale", description: rationaleForEvent(ev) },
                      ];
                    } else if (ev.type === "shopify_checkout_toggle") {
                      const { label: statusLabel, tone: statusTone } = getStateLabelTone(ev.state)
                      items = [
                        { term: "Action", description: actionLabel(ev.type) },
                        { term: "Source", description: meta?.source || "Shopify" },
                        { term: "Session Id", description: ev.sessionId || "—" },
                        { term: "Outcome", description: <Badge tone={statusTone}>{statusLabel}</Badge> },
                        { term: "Timestamp", description: formatDate(ev.createdAt) },
                        { term: "IP Country", description: countryLabel(ev.session?.ipCountry) || "—" },
                        { term: "Billing Country", description: countryLabel(ev.session?.billingCountry) || "—" },
                        {
                          term: "Checkbox Configuration",
                          description: (() => {
                            const label = prettyMode(ev.session?.mode);
                            return ev.session?.variant ? `${label} (${ev.session.variant})` : label;
                          })(),
                        },
                        {
                          term: "Display Text",
                          description: ev.session?.displayText ? (
                            <Button
                              variant="plain"
                              onClick={() =>
                                openMarketing(
                                  `Marketing information (session ${ev.session?.id || ""})`,
                                  ev.session.displayText
                                )
                              }
                            >
                              Click here to view
                            </Button>
                          ) : "—",
                        },
                        {
                          term: "Marteting information",
                          description: ev.session?.marketingPreferences ? (
                            <Button
                              variant="plain"
                              onClick={() =>
                                openMarketing(
                                  `Marketing information (session ${ev.session?.id || ""})`,
                                  ev.session.marketingPreferences
                                )
                              }
                            >
                              Click here to view
                            </Button>
                          ) : "—",
                        },
                        {
                          term: "Privacy Policy",
                          description: ev.session?.privacyUrl ? (
                            <Link url={ev.session?.privacyUrl} target="_blank" removeUnderline>
                              {ev.session.privacyUrl}
                            </Link>
                          ) : "—",
                        },
                        { term: "Rationale", description: rationaleForEvent(ev) }
                      ];
                    } else if (ev.type === "shopify_sync") {
                      const { label: statusLabel, tone: statusTone } = getStateLabelTone(ev.state);
                      items = [
                        { term: "Action", description: actionLabel(ev.type) },
                        { term: "Source", description: meta?.source || "Shopify" },
                        { term: "Outcome", description: <Badge tone={statusTone}>{statusLabel}</Badge> },
                        { term: "Timestamp", description: formatDate(ev.createdAt) },
                        { term: "Rationale", description: rationaleForEvent(ev) }
                      ];
                    } else {
                      items = [
                        { term: "Action", description: actionLabel(ev.type) },
                        { term: "Timestamp", description: formatDate(ev.createdAt) }
                      ];
                    }

                    return (
                      <Box key={ev.id}>
                        <Box paddingBlock="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="p" variant="bodyMd">
                              {formatDate(ev.createdAt)} - {actionLabel(ev.type)}
                            </Text>
                            <Button
                              variant="plain"
                              icon={<Icon source={openState ? ChevronUpIcon : ChevronDownIcon} />}
                              accessibilityLabel={openState ? "Collapse" : "Expand"}
                              onClick={(e) => { e.stopPropagation(); toggle(ev.id); }}
                            />
                          </InlineStack>
                        </Box>

                        <Collapsible open={openState} id={`ev-${ev.id}`}>
                          <Box paddingInline="400" paddingBlockEnd="400">
                            <DescriptionList items={items} />
                          </Box>
                        </Collapsible>

                        {idx !== events.length - 1 && <Divider />}
                      </Box>
                    );
                  })
                )}
              </Box>
            </BlockStack>
          </Card>
        </BlockStack>
      </Box>

      {/* Polaris Modal for “Marketing information” */}
      <Modal
        open={mktModal.open}
        onClose={closeMarketing}
        title={mktModal.title || "Marketing information"}
        primaryAction={{ content: "Close", onAction: closeMarketing }}
      >
        <Box padding="400">
          <Text as="p" variant="bodyMd" tone="subdued" breakWord>
            {stripTags(mktModal.content) || "—"}
          </Text>
        </Box>
      </Modal>
    </Page>
  );
}
