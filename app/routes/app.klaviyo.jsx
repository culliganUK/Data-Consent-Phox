import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { enc, dec } from "~/utils/crypto.server";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Icon,
  Box,
  Banner,
  Select,
  Link,
  Spinner,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { ClipboardIcon, DeleteIcon } from "@shopify/polaris-icons";

/* ------------------------------ helpers ------------------------------ */

async function fetchKlaviyoLists(key) {
  // Klaviyo HTTP API (private key)
  // Docs: https://developers.klaviyo.com/en/reference/get_lists
  const res = await fetch("https://a.klaviyo.com/api/lists", {
    headers: {
      Accept: "application/json",
      Authorization: `Klaviyo-API-Key ${key}`,
      Revision: "2024-10-15",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Klaviyo list fetch failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  const items = (json?.data || []).map((d) => ({
    label: d?.attributes?.name || d?.id,
    value: d?.id,
  }));
  return items;
}

/* ------------------------------ loader ------------------------------ */

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const row = await prisma.klaviyoSettings.findUnique({
    where: { shop: session.shop },
  });

  const decryptedKey = row?.encryptedKey ? dec(row.encryptedKey) : "";
  let listOptions = [];
  let loadError = null;

  if (decryptedKey) {
    try {
      listOptions = await fetchKlaviyoLists(decryptedKey);
    } catch (e) {
      loadError = e.message || "Failed to load lists from Klaviyo.";
    }
  }

  return json({
    shop: session.shop,
    hasKey: !!decryptedKey,
    key: decryptedKey,
    keySuffix: decryptedKey ? decryptedKey.slice(-4) : "",
    listOptions,            // [{label, value}]
    saved: {
      singleOptListId: row?.singleOptListId || "",
      singleOptListName: row?.singleOptListName || "",
      doubleOptListId: row?.doubleOptListId || "",
      doubleOptListName: row?.doubleOptListName || "",
    },
    loadError,
  });
}

/* ------------------------------ action ------------------------------ */

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("_intent");

  if (intent === "saveKey") {
    const key = String(form.get("key") || "").trim();
    if (!key) return json({ ok: false, error: "Missing key" }, { status: 400 });

    await prisma.klaviyoSettings.upsert({
      where: { shop: session.shop },
      update: { encryptedKey: enc(key), keySuffix: key.slice(-4) },
      create: {
        shop: session.shop,
        encryptedKey: enc(key),
        keySuffix: key.slice(-4),
      },
    });
    return json({ ok: true });
  }

  if (intent === "deleteKey") {
    await prisma.klaviyoSettings.upsert({
      where: { shop: session.shop },
      update: {
        encryptedKey: "",
        keySuffix: null,
        singleOptListId: null,
        singleOptListName: null,
        doubleOptListId: null,
        doubleOptListName: null,
      },
      create: { shop: session.shop, encryptedKey: "" },
    });
    return json({ ok: true });
  }

  if (intent === "saveLists") {
    const singleOptListId = String(form.get("singleOptListId") || "");
    const singleOptListName = String(form.get("singleOptListName") || "");
    const doubleOptListId = String(form.get("doubleOptListId") || "");
    const doubleOptListName = String(form.get("doubleOptListName") || "");

    await prisma.klaviyoSettings.update({
      where: { shop: session.shop },
      data: {
        singleOptListId: singleOptListId || null,
        singleOptListName: singleOptListName || null,
        doubleOptListId: doubleOptListId || null,
        doubleOptListName: doubleOptListName || null,
      },
    });
    return json({ ok: true });
  }

  return json({ ok: true });
}

/* ------------------------------ component ------------------------------ */

export default function KlaviyoSettingsPage() {
  const { hasKey, key, keySuffix, listOptions, saved, loadError } = useLoaderData();
  const submit = useSubmit();
  const nav = useNavigation();

  const [inputKey, setInputKey] = useState("");
  const [copied, setCopied] = useState(false);

  // list selections
  const [singleId, setSingleId] = useState(saved.singleOptListId || "");
  const [doubleId, setDoubleId] = useState(saved.doubleOptListId || "");

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      shopify.toast.show("Key copied to clipboard");
    } catch {
      shopify.toast.error("Failed to copy key to clipboard");
    }
  };

  const removeKey = () => {
    const fd = new FormData();
    fd.set("_intent", "deleteKey");
    submit(fd, { method: "post" });
  };

  const saveKey = () => {
    const fd = new FormData();
    fd.set("_intent", "saveKey");
    fd.set("key", inputKey);
    submit(fd, { method: "post" });
  };

  const saveLists = () => {
    // map ids to names for storage
    const opt = (id) => listOptions.find((o) => o.value === id)?.label || "";
    const fd = new FormData();
    fd.set("_intent", "saveLists");
    fd.set("singleOptListId", singleId);
    fd.set("singleOptListName", opt(singleId));
    fd.set("doubleOptListId", doubleId);
    fd.set("doubleOptListName", opt(doubleId));
    submit(fd, { method: "post" });
  };

  const listsLoading = nav.state !== "idle"; // coarse loader indicator

  return (
    <Page title="Klaviyo Integration">
      <Box paddingBlockEnd={800}>
        <BlockStack gap="400">
          {/* --- Key card --- */}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Authentication</Text>

              {!hasKey ? (
                <>
                  <Text as="p" tone="subdued">
                    Paste your Klaviyo <b>Private API Key</b> and click Save.
                  </Text>
                  <InlineStack align="start" gap="200">
                    <TextField
                      type="text"
                      label="Private API Key"
                      labelHidden
                      value={inputKey}
                      onChange={setInputKey}
                      autoComplete="off"
                      placeholder="pk_************************"
                    />
                    <Button primary onClick={saveKey} disabled={!inputKey.trim()}>
                      Save
                    </Button>
                  </InlineStack>
                  <Banner tone="info">
                    Create a Private API key in Klaviyo:{" "}
                    <Link url="https://www.klaviyo.com/account#api-keys" target="_blank">
                      Settings → API Keys
                    </Link>
                  </Banner>
                </>
              ) : (
                <>
                  <Text as="p" tone="subdued">
                    Your Private API Key is stored securely. You can copy or remove it below.
                  </Text>
                  <Box
                    padding="300"
                    borderRadius="200"
                    borderWidth="1"
                    borderColor="border"
                    background="bg-surface-tertiary"
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <Text variant="bodySm" tone="subdued">Private API Key</Text>
                        <Text as="p" variant="bodyMd" fontFamily="mono">
                          pk_********************{keySuffix}
                        </Text>
                      </BlockStack>

                      <InlineStack gap="200">
                        <Button
                          icon={<Icon source={ClipboardIcon} />}
                          onClick={copy}
                          size="large"
                          accessibilityLabel="Copy key"
                        />
                        <Button
                          variant="primary"
                          tone="critical"
                          icon={<Icon source={DeleteIcon} />}
                          onClick={removeKey}
                          size="large"
                          accessibilityLabel="Delete key"
                        />
                      </InlineStack>
                    </InlineStack>
                  </Box>
                </>
              )}
            </BlockStack>
          </Card>

          {/* --- Lists card (only when key is present) --- */}
          {hasKey && (
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Klaviyo Email Settings</Text>

                {loadError ? (
                  <Banner tone="critical">{loadError}</Banner>
                ) : listOptions.length === 0 ? (
                  <InlineStack gap="200" align="start" blockAlign="center">
                    <Spinner size="small" />
                    <Text tone="subdued">Loading lists…</Text>
                  </InlineStack>
                ) : (
                  <>
                    <BlockStack gap="300">
                      <Text as="p" tone="subdued">
                        Choose which lists to sync subscribers to. You can change these at any time.
                      </Text>

                      <Select
                        label="Single Opt-in List"
                        options={[{ label: "— Select a list —", value: "" }, ...listOptions]}
                        value={singleId}
                        onChange={setSingleId}
                      />

                      <Select
                        label="Double Opt-in List"
                        options={[{ label: "— Select a list —", value: "" }, ...listOptions]}
                        value={doubleId}
                        onChange={setDoubleId}
                      />

                      <InlineStack gap="200">
                        <Button variant="primary" onClick={saveLists} disabled={listsLoading}>
                          Save
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </>
                )}
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </Box>
    </Page>
  );
}
