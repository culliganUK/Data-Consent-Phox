// extensions/consent-widget/checkout.js
import '@shopify/ui-extensions/preact';
import {render} from "preact";
import { useEffect, useState } from "preact/hooks";

// ENTRY POINT
export default async () => {
  render(<Extension />, document.body)
};

function Extension() {
  // ===== STATE =====
  const [settings, setSettings] = useState({
    displayText: "",
    privacyUrl: "",
    mode: "NO_CHECKBOX",
    marketingPreferences: "",
  });

  const [sessionId, setSessionId] = useState(null);
  const [optStatus, setOptStatus] = useState(false);

  const API_BASE = "https://data-consent-phox-production.up.railway.app";

  const checkoutToken = shopify.checkoutToken.value ?? '';
  const email = (shopify.buyerIdentity?.email?.value || '').toLowerCase().trim();

  // ===== LOAD SETTINGS FROM SERVER =====
  useEffect(() => {

    let cancelled = false;

    (async () => {
      try {
        const token = await shopify.sessionToken.get();

        const res = await fetch(`${API_BASE}/api/settings/privacy`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Checkout-Token": checkoutToken,
            "X-Customer-Email": email,
          },
          cache: "no-store",
        });

        const json = await res.json();
        if (cancelled) return;

        setSettings(json);

        if (json.sessionId) {
          setSessionId(json.sessionId);
          await shopify.applyAttributeChange({
            type: "updateAttribute",
            key: "consent_uuid",
            value: json.sessionId,
          });
        }
      } catch (err) {
        console.error("Failed to load settings", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [email, checkoutToken]);

  // ===== FEATURE CHECK (2025-10 requirement) =====
  if (!shopify.instructions.value.attributes.canUpdateAttributes) {
    return (
      <s-banner heading="Marketing consent" tone="warning">
        Attribute changes are not supported in this checkout.
      </s-banner>
    );
  }

  const { mode, displayText, privacyUrl, marketingPreferences } = settings;

  return (
    <s-stack gap="base">
      {/* ===== MODAL ===== */}
      <s-modal id="preferences-modal" >
        <s-stack gap="base">
          <s-heading>Marketing preferences</s-heading>
          {renderMarketing(marketingPreferences)}
        </s-stack>
      </s-modal>

      {/* ===== CHECKBOX IF REQUIRED ===== */}
      {mode !== "NO_CHECKBOX" && (
        <s-grid gridTemplateColumns="1fr auto" gap="base">
          <s-grid-item>
            <s-checkbox
              checked={optStatus}
              onChange={async (e) => {
                // Web component event target has checked property at runtime
                const checked = e.target['checked'] ?? !optStatus;
                setOptStatus(checked);

                const intendsSubscribe =
                  mode === "OPT_OUT" ? !checked : mode === "OPT_IN" ? checked : null;

                const state =
                  intendsSubscribe === true
                    ? "SUBSCRIBED"
                    : intendsSubscribe === false
                    ? "UNSUBSCRIBED"
                    : "NOT_SUBSCRIBED";

                try {
                  const token = await shopify.sessionToken.get();
                  await fetch(`${API_BASE}/api/consent/event`, {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      sessionId,
                      type: "shopify_checkout_toggle",
                      state,
                      note: "checkout",
                    }),
                  });
                } catch (err) {
                  console.error("toggle failed", err);
                }
              }}
            />
          </s-grid-item>
          <s-grid-item>
            <s-text>{renderMarketing(displayText)}</s-text>
          </s-grid-item>
        </s-grid>
      )}

      {/* ===== TEXT + LINK TO OPEN MODAL ===== */}
      <s-text>
        <s-link command="--show" commandFor="preferences-modal" tone="neutral"><s-text type="strong" color="subdued">Click here</s-text></s-link>
        {" "}
        for an overview of how your personal data is processed for marketing purposes,
        or see our{" "}
        <s-text type="strong">
          <s-link href={privacyUrl} target="_blank" tone="neutral">
            Privacy Policy
          </s-link>
        </s-text>
        .
      </s-text>
    </s-stack>
  );
}

//
// ===============================================================
//  MARKETING TEXT PARSER (converted to Shopify 2025-10 components)
// ===============================================================
//

function renderMarketing(html) {
  const parts = [];
  let cursor = 0;

  const blockRe = /<(p|ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let match;

  const pushParagraphs = (fragment) => {
    const pMatches = fragment.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
    pMatches.forEach((pHtml) => {
      const inner = pHtml.replace(/^<p[^>]*>|<\/p>$/gi, "");
      parts.push(<s-text>{renderInline(inner)}</s-text>);
    });
  };

  while ((match = blockRe.exec(html))) {
    const before = html.slice(cursor, match.index);
    if (before.trim()) pushParagraphs(before);

    const block = match[0];
    const tag = match[1].toLowerCase();

    if (tag === "p") {
      const inner = block.replace(/^<p[^>]*>|<\/p>$/gi, "");
      parts.push(<s-paragraph>{renderInline(inner)}</s-paragraph>);
    } else if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const items = [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(
        (li) => li[1]
      );

      const listItems = items.map((inner, i) => (
        <s-list-item key={i}>
          <s-text>{renderInline(inner)}</s-text>
        </s-list-item>
      ));

      parts.push(
        ordered ? (
          <s-ordered-list>{listItems}</s-ordered-list>
        ) : (
          <s-unordered-list>{listItems}</s-unordered-list>
        )
      );
    }

    cursor = match.index + block.length;
  }

  const tail = html.slice(cursor);
  if (tail.trim()) pushParagraphs(tail);

  if (!parts.length) return <s-text>{renderInline(html)}</s-text>;
  return parts;
}

function renderInline(input) {
  const normalized = decodeHtml(input)
    .replace(/<strong[^>]*>/gi, "<b>")
    .replace(/<\/strong>/gi, "</b>");

  const nodes = [];
  let last = 0;
  const re = /<b[^>]*>([\s\S]*?)<\/b>/gi;
  let m;

  while ((m = re.exec(normalized))) {
    const before = strip(normalized.slice(last, m.index));
    if (before) nodes.push(before);

    const boldText = strip(m[1]);
    if (boldText)
      nodes.push(
        <s-text type="strong" key={`b-${nodes.length}`}>
          {boldText}
        </s-text>
      );

    last = re.lastIndex;
  }

  const tail = strip(normalized.slice(last));
  if (tail) nodes.push(tail);

  return nodes;
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function strip(s) {
  return s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "");
}
