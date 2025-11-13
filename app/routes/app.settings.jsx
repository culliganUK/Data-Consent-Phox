// app/routes/app.settings.jsx
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  Form,
  useSubmit,
} from "@remix-run/react";
import { prisma } from "~/db.server";
import { authenticate } from "~/shopify.server";
import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  Page,
  Card,
  TextField,
  Text,
  Box,
  BlockStack,
  InlineGrid,
  Divider,
  Banner,
} from "@shopify/polaris";
import { SaveBar } from "@shopify/app-bridge-react";

const SHOP_INFO_QUERY = `#graphql
  query ShopInfo {
    shop {
      name
      contactEmail
      myshopifyDomain
      url
    }
  }
`;

function buildDefaults(meta) {
  const url = (meta.url || "").replace(/\/$/, "");
  const privacyUrl = url ? `${url}/policies/privacy-policy` : "";

  return {
    optInText: `We would like to email you news, special offers and other promotional material that may be of interest to you. Tick the box to <b>opt in</b>.`,
    optOutText: `We would like to email you news, special offers and other promotional material that may be of interest to you. Tick the box to <b>opt out.</b>`,
    marketingInfo: `<p>We, ${meta.name}, may send you direct marketing communications, product updates, and promotional offers if you do not opt out of receiving such communications by ticking the box provided at checkout.</p>
      <p>If you are purchasing from our European store or are located in the UK or EEA, the legal basis for this processing is our legitimate interests — namely, to grow an engaged customer base and drive repeat purchases. This applies only where you have completed a purchase with us and have not opted out of marketing. In line with applicable laws, these communications will relate to our own products or services.</p>
      <p>We do not use your personal data for third-party marketing unless we have your separate, explicit consent, or the laws in your country allow such processing.</p>
      <p>You will always have full control of your marketing preferences. If you do not wish to continue receiving marketing information from us at any time:</p>
      <ul>
        <li>You can unsubscribe by using the unsubscribe directions or link included in marketing communication from us; or</li>
        <li>You may withdraw your consent by contacting us by e-mail at <a href="mailto:${meta.email}">${meta.email}</a>.</li>
      </ul>
      <p>If you are based in the UK or EEA or are a customer of our European store, you also have the right to object to your personal data being used for marketing purposes, including profiling, at any time by emailing us at the address above.</p>
      <p>We aim to process all requests as quickly as possible, but please allow a few days for your preferences to take full effect.</p>`,
    privacyUrl,
  };
}

// Helper function for URL validation
function isValidUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/* ------------------------- LOADER ------------------------- */
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let meta = {
    name: shop,
    url: `https://${shop}`,
    email: `support@${shop.replace(/^https?:\/\//, "")}`,
  };

  try {
    const res = await admin.graphql(SHOP_INFO_QUERY);
    const { data } = await res.json();
    const s = (data && data.shop) || {};

    const url = s.url || shop;
    const email = s.contactEmail || meta.email;

    meta = {
      name: s.name || shop,
      url,
      email,
    };
  } catch (e) {
    console.warn("Failed to fetch shop info, using fallbacks:", e);
  }

  const defaults = buildDefaults(meta);

  const settings = await prisma.appSettings.findUnique({ where: { shop } });

  const initial = settings
    ? {
        ...defaults, // defaults present
        optInText: settings.optInText ?? defaults.optInText,
        optOutText: settings.optOutText ?? defaults.optOutText,
        marketingInfo: settings.marketingInfo ?? defaults.marketingInfo,
        privacyUrl: settings.privacyUrl ?? defaults.privacyUrl,
      }
    : { ...defaults };

  return json({ initial, meta });
}

/* ------------------------- ACTION (no redirect) ------------------------- */
export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const fields = {
    optInText: String(form.get("optInText") || "").trim(),
    optOutText: String(form.get("optOutText") || "").trim(),
    marketingInfo: String(form.get("marketingInfo") || "").trim(),
    privacyUrl: String(form.get("privacyUrl") || "").trim(),
  };

  // Validation
  const errors = {};
  if (!fields.optInText) errors.optInText = "Opt-in display text is required.";
  if (!fields.optOutText) errors.optOutText = "Opt-out display text is required.";
  if (!fields.marketingInfo) errors.marketingInfo = "Marketing information is required.";
  // Only validate URL if it's provided, otherwise assume it's blank/optional (though the default is "")
  if (fields.privacyUrl && !isValidUrl(fields.privacyUrl))
    errors.privacyUrl = "Privacy URL must be a valid http(s) link.";

  if (Object.keys(errors).length > 0) {
    return json({ ok: false, errors, fields }, { status: 400 });
  }

  await prisma.appSettings.upsert({
    where: { shop },
    update: { ...fields },
    create: { shop, ...fields },
  });

  // Return success along with the saved fields to update the client-side baseline
  return json({ ok: true, saved: fields });
}

/* ------------------------- ROUTE COMPONENT ------------------------- */
export default function Route() {
  const { initial } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const pendingSaveRef = useRef(false);

  // Helper to ensure we always start with defaults + initial data
  const initialData = useMemo(() => initial ?? {}, [initial]);

  // State 1: The current saved data (acts as the baseline for dirty checking)
  const [baseline, setBaseline] = useState(initialData);

  // State 2: The current form input values (controlled inputs)
  const [values, setValues] = useState(initialData);

  // Sync initial loader data to state on load
  useEffect(() => {
    setBaseline(initialData);
    setValues(initialData);
  }, [initialData]);

  // If server returned validation errors, keep user-typed values
  useEffect(() => {
    if (actionData?.fields) {
      // If validation failed, update form values with the submitted (and potentially corrected) fields
      setValues((prev) => ({ ...prev, ...actionData.fields }));
    }
  }, [actionData]);

  // Post-save logic (when saving finishes and action succeeds)
  const [showSaved, setShowSaved] = useState(false);
  const busy = navigation.state !== "idle";

  useEffect(() => {
    if (!busy) pendingSaveRef.current = false;
    if (!busy && actionData?.ok && actionData.saved) {
      const savedData = actionData.saved;
      setBaseline(savedData);
      setValues(savedData);
      setShowSaved(true);
      shopify.toast.show("Settings saved");
    }
  }, [busy, actionData]);

  // Form handlers
  const onChange = (k) => (val) => setValues((v) => ({ ...v, [k]: val }));

  const handleSave = () => {
    const form = document.querySelector('form[data-save-bar]');
    if (!form) return;
    pendingSaveRef.current = true;
    submit(new FormData(form), { method: "post" });
  };

  const handleDiscard = () => {
    pendingSaveRef.current = false;
    setValues(baseline);
  };

  return (
    <Page title="Settings" divider>
      <SaveBar id="settings-save-bar">
        <button variant="primary" onClick={handleSave}>Save</button>
        <button onClick={handleDiscard}>Discard</button>
      </SaveBar>
      <Box paddingBlockEnd={800}>
        <Form data-save-bar method="post">
          <BlockStack gap={{ xs: "800", sm: "400" }}>
            {/* Action Errors Banner */}
            {actionData?.errors ? (
              <Banner tone="critical" title="Please fix the errors before saving">
                <p>Some fields are missing or invalid.</p>
              </Banner>
            ) : null}

            {/* Display texts section */}
            <InlineGrid columns={{ xs: "1fr", md: "2fr 5fr" }} gap="400">
              <Box as="section" paddingInlineStart={{ xs: 400, sm: 0 }} paddingInlineEnd={{ xs: 400, sm: 0 }}>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">Display text</Text>
                  <Text as="p" variant="bodyMd">
                    Configure the customer-facing text shown next to your consent controls.
                  </Text>
                </BlockStack>
              </Box>
              <Card roundedAbove="sm">
                <BlockStack gap="400">
                  <TextField
                    name="optInText"
                    label="Opt-in display text"
                    value={values.optInText}
                    onChange={onChange("optInText")}
                    autoComplete="off"
                    multiline
                    error={actionData?.errors?.optInText}
                  />
                  <TextField
                    name="optOutText"
                    label="Opt-out display text"
                    value={values.optOutText}
                    onChange={onChange("optOutText")}
                    autoComplete="off"
                    multiline
                    error={actionData?.errors?.optOutText}
                  />
                </BlockStack>
              </Card>
            </InlineGrid>
            <Divider />
            {/* Legal & information section */}
            <InlineGrid columns={{ xs: "1fr", md: "2fr 5fr" }} gap="400">
              <Box as="section" paddingInlineStart={{ xs: 400, sm: 0 }} paddingInlineEnd={{ xs: 400, sm: 0 }}>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">Legal & information</Text>
                  <Text as="p" variant="bodyMd">
                    Provide the marketing information copy and link to your privacy policy.
                  </Text>
                </BlockStack>
              </Box>
              <Card roundedAbove="sm">
                <BlockStack gap="400">
                  <TextField
                    name="marketingInfo"
                    label="Marketing information"
                    value={values.marketingInfo}
                    onChange={onChange("marketingInfo")}
                    autoComplete="off"
                    multiline={6}
                    helpText="Explain what customers are opting into/out of. HTML is supported."
                    error={actionData?.errors?.marketingInfo}
                  />
                  <TextField
                    name="privacyUrl"
                    type="url"
                    label="Privacy URL"
                    value={values.privacyUrl}
                    onChange={onChange("privacyUrl")}
                    autoComplete="off"
                    placeholder="https://example.com/privacy"
                    error={actionData?.errors?.privacyUrl}
                  />
                </BlockStack>
              </Card>
            </InlineGrid>
          </BlockStack>
        </Form>
      </Box>
    </Page>
  );
}
