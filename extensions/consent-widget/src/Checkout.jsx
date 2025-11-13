import {
  reactExtension,
  BlockStack,
  Text,
  Checkbox,
  Link,
  List,
  ListItem,
  TextBlock,
  Modal,
  useApi,
  useCheckoutToken,
  useApplyAttributeChange,
  useEmail,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect, useState } from "react";

export default reactExtension("purchase.checkout.block.render", () => <App />);

export function renderMarketing(html) {
  const parts = [];
  let cursor = 0;

  // Match block tags in order
  const blockRe = /<(p|ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let m;

  const pushParagraphs = (fragment) => {
    const pMatches = fragment.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
    pMatches.forEach((pHtml, i) => {
      const inner = pHtml.replace(/^<p\b[^>]*>|<\/p>$/gi, "");
      const nodes = renderInline(inner);
      if (nodes && nodes.length) {
        parts.push(<TextBlock key={`p-${parts.length}-${i}`}>{nodes}</TextBlock>);
      }
    });
  };

  while ((m = blockRe.exec(html))) {
    const before = html.slice(cursor, m.index);
    if (before.trim()) pushParagraphs(before);

    const block = m[0];
    const tag = m[1].toLowerCase();

    if (tag === "p") {
      const inner = block.replace(/^<p\b[^>]*>|<\/p>$/gi, "");
      const nodes = renderInline(inner);
      if (nodes && nodes.length) {
        parts.push(<TextBlock key={`p-${parts.length}`}>{nodes}</TextBlock>);
      }
    } else if (tag === "ul" || tag === "ol") {
      const marker = tag === "ol" ? "number" : "bullet";
      const items = [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => li[1]);

      if (items.length) {
        parts.push(
          <List marker={marker} spacing="tight" key={`list-${parts.length}`}>
            {items.map((itemHtml, i) => (
              <ListItem key={i}>
                <Text>{renderInline(itemHtml)}</Text>
              </ListItem>
            ))}
          </List>
        );
      }
    }

    cursor = m.index + block.length;
  }

  const tail = html.slice(cursor);
  if (tail.trim()) pushParagraphs(tail);

  if (!parts.length) return <TextBlock>{renderInline(html)}</TextBlock>;
  return parts;
}

// --- helpers ---

function renderInline(input) {
  // Decode entities and normalize <strong> to <b>
  const normalized = decode(input)
    .replace(/<strong\b[^>]*>/gi, "<b>")
    .replace(/<\/strong>/gi, "</b>");

  const nodes = [];
  let last = 0;
  const re = /<b\b[^>]*>([\s\S]*?)<\/b>/gi;
  let m;

  while ((m = re.exec(normalized))) {
    const before = stripTags(normalized.slice(last, m.index));
    if (before) nodes.push(before);

    const boldText = stripTags(m[1]);
    if (boldText) nodes.push(<Text emphasis="bold" key={`b-${nodes.length}`}>{boldText}</Text>);

    last = re.lastIndex;
  }

  const tail = stripTags(normalized.slice(last));
  if (tail) nodes.push(tail);

  return nodes;
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s) {
  // Remove everything except text; handle <br> as space
  return s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "");
}

function App() {
  const { sessionToken } = useApi();
  const checkoutToken = useCheckoutToken();
  const applyAttr = useApplyAttributeChange();
  const email = useEmail();

  const [settings, setSettings] = useState({ privacyUrl: "" });
  const [sessionId, setSessionId] = useState(null);

  const footerPrivacyLink = settings?.privacyUrl || '';
  const displayText = settings?.displayText || '';
  const mode = settings?.mode || 'NO_CHECKBOX';
  const marketingPreferences= settings?.marketingPreferences || '';

  // Unchecked = subscribed after order (soft opt-in) unless they tick to opt out
  const [optStatus, setOptStatus] = useState(false);

  const API_BASE = 'https://data-consent-phox-production.up.railway.app';

  async function callServer() {
    const token = await sessionToken.get();
    const res = await fetch(`${API_BASE}/api/settings/privacy`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Checkout-Token": checkoutToken ?? "",
        "X-Customer-Email": (email || "").toLowerCase().trim()
      },
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await callServer();
        if (cancelled) return;
        // Avoid unnecessary state updates to prevent re-renders
        setSettings((prev) => {
          if (
            prev?.privacyUrl === json?.privacyUrl &&
            prev?.displayText === json?.displayText &&
            prev?.opt === json?.opt &&
            prev?.storeDomain === json?.storeDomain
          ) {
            return prev;
          }
          return json;
        });

        // Write consent_uuid once (idempotent even if called twice)
        if (json?.sessionId) {
          setSessionId(json.sessionId);
          console.log("sessionId found", json.sessionId);

          await applyAttr({
            type: "updateAttribute",
            key: "consent_uuid",
            value: json.sessionId,
          });
        } else {
          console.log("No sessionId found");
        }
      } catch (e) {
        console.log(e);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionToken, checkoutToken, email]);

  return (
    <BlockStack spacing="tight">
      {mode != 'NO_CHECKBOX' ? (
        <>
          <Checkbox
            id="email-opt-out"
            name="email-opt-out"
            checked={optStatus}
            onChange={async (checked) => {
              setOptStatus(checked);
              // Normalize checkbox → intends to be subscribed?
              const intendsSubscribe =
                mode === "OPT_OUT" ? !checked :
                mode === "OPT_IN"  ?  checked :
                null;

              const state =
                intendsSubscribe === true  ? "SUBSCRIBED"   :
                intendsSubscribe === false ? "UNSUBSCRIBED" :
                "NOT_SUBSCRIBED";

              // Log an event to the API
              try {
                const token = await sessionToken.get();
                await fetch(`${API_BASE}/api/consent/event`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  credentials: "omit",
                  body: JSON.stringify({
                    sessionId,
                    type: "shopify_checkout_toggle",
                    state,
                    note: "checkout",
                  }),
                });
              } catch (e) {
                console.log("toggle event failed", e);
              }
            }}
          >
            {renderMarketing(displayText)}
          </Checkbox>
          <Text>
            <Text emphasis="bold">
            <Link
              appearance="monochrome"
              overlay={
                <Modal
                  id="preferences-modal"
                  padding
                  title="Marketing preferences"
                >
                  <BlockStack spacing="tight">{renderMarketing(marketingPreferences)}</BlockStack>
                </Modal>
              }
            >
              Click here
            </Link></Text> for an overview of how your personal data is processed for marketing purposes or see our <Text emphasis="bold"><Link to={footerPrivacyLink} external appearance="monochrome">Privacy Policy</Link></Text> for further information.
          </Text>
        </>
      ) : (
        <Text>
          <Text emphasis="bold">
          <Link
            appearance="monochrome"
            overlay={
              <Modal
                id="preferences-modal"
                padding
                title="Marketing preferences"
              >
                <BlockStack spacing="tight">{renderMarketing(marketingPreferences)}</BlockStack>
              </Modal>
            }
          >
            Click here
          </Link></Text> for an overview of how your personal data is processed for marketing purposes or see our <Text emphasis="bold"><Link to={footerPrivacyLink} external appearance="monochrome">Privacy Policy</Link></Text> for further information.
        </Text>
      )}
    </BlockStack>
  );
}
