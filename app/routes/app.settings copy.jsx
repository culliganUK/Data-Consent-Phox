// app/routes/app.settings.jsx
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, Form } from "@remix-run/react";
import { prisma } from "~/db.server";
import { authenticate } from "~/shopify.server";
import React, { useEffect, useMemo, useState } from "react";
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
  Toast,
  Button,
  InlineStack,
} from "@shopify/polaris";

const DEFAULTS = {
  optInText: `We would like to email you news, special offers and other promotional material that may be of interest to you. Tick the box to <b>opt in</b>.`,
  optOutText: `We would like to email you news, special offers and other promotional material that may be of interest to you. Tick the box to <b>opt out.</b>`,
  marketingInfo: `<p>We, Phox, may send you direct marketing communications, product updates, and promotional offers if you do not opt out of receiving such communications by ticking the box provided at checkout.</p>
    <p>If you are purchasing from our European store or are located in the UK or EEA, the legal basis for this processing is our legitimate interests — namely, to grow an engaged customer base and drive repeat purchases. This applies only where you have completed a purchase with us and have not opted out of marketing. In line with applicable laws, these communications will relate to our own products or services.</p>
    <p>We do not use your personal data for third-party marketing unless we have your separate, explicit consent, or the laws in your country allow such processing.</p>
    <p>You will always have full control of your marketing preferences. If you do not wish to continue receiving marketing information from us at any time:</p>
    <ul>
    <li>You can unsubscribe by using the unsubscribe directions or link included in marketing communication from us; or</li>
    <li>You may withdraw your consent by contacting us by e-mail at service@phoxwater.com,</li>
    </ul>
    <p>If you are based in the UK or EEA or are a customer of our European store, you also have the right to object to your personal data being used for marketing purposes, including profiling, at any time by emailing us at the address above.</p>
    <p>We aim to process all requests as quickly as possible, but please allow a few days for your preferences to take full effect.</p>`,
  privacyUrl: "",
};

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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.appSettings.findUnique({ where: { shop } });

  const initial = settings
    ? {
        optInText: settings.optInText,
        optOutText: settings.optOutText,
        marketingInfo: settings.marketingInfo,
        privacyUrl: settings.privacyUrl,
      }
    : { ...DEFAULTS };

  return json({ initial });
}

/* ------------------------- ACTION ------------------------- */
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
  if (!isValidUrl(fields.privacyUrl)) errors.privacyUrl = "Privacy URL must be a valid http(s) link.";

  if (Object.keys(errors).length > 0) {
    return json({ ok: false, errors, fields }, { status: 400 });
  }

  await prisma.appSettings.upsert({
    where: { shop },
    update: { ...fields },
    create: { shop, ...fields },
  });

  // Post/Redirect/Get to clear resubmits and show toast
  const url = new URL(request.url);
  url.searchParams.set("saved", "1");
  return redirect(url.toString());
}

/* ------------------------- ROUTE COMPONENT ------------------------- */
export default function Route() {
  const { initial } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  // show toast when redirected with ?saved=1
  const [showSaved, setShowSaved] = useState(
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("saved") === "1"
  );

  // Form state (controlled inputs so Polaris shows current values)
  const baseline = useMemo(() => ({ ...DEFAULTS, ...(initial || {}) }), [initial]);
  const [values, setValues] = useState(baseline);

  useEffect(() => {
    setValues(baseline);
  }, [baseline]);

  // If server returned validation errors, keep user-typed values
  useEffect(() => {
    if (actionData?.fields) setValues((prev) => ({ ...prev, ...actionData.fields }));
  }, [actionData]);

  const saving = navigation.state === "submitting";

  const onChange = (k) => (val) => setValues((v) => ({ ...v, [k]: val }));

  return (
    <Page title="Settings" divider>
      <Form
        data-save-bar
        onsubmit="console.log('submit', new FormData(event.target)); event.preventDefault();"
        method="post"
        replace
      >
        <BlockStack gap={{ xs: "800", sm: "400" }}>
          {actionData?.errors ? (
            <Banner tone="critical" title="Please fix the errors before saving">
              <p>Some fields are missing or invalid.</p>
            </Banner>
          ) : null}

          {/* Display texts */}
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

          {/* Marketing info + Privacy URL */}
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
                  helpText="Explain what customers are opting into/out of."
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

          {/* Actions row */}
          <Box paddingBlockStart="400">
            <InlineStack gap="300" align="end">
              <Button submit variant="primary" loading={saving}>
                Save
              </Button>
            </InlineStack>
          </Box>
        </BlockStack>
      </Form>

      {showSaved && (
        <Toast content="Settings saved" onDismiss={() => setShowSaved(false)} duration={2500} />
      )}
    </Page>
  );
}
