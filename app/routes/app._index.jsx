// app/routes/app.dashboard.jsx
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  InlineStack,
  Text,
  Badge,
} from "@shopify/polaris";

export async function loader({ request }) {
  await authenticate.admin(request);

  const { session } = await authenticate.admin(request);
  const shop = session?.shop;

  const [subscribed, unsubscribed] = await Promise.all([
    prisma.customer.count({
      where: { ...(shop && { shop }), lastState: "SUBSCRIBED" },
    }),
    prisma.customer.count({
      where: { ...(shop && { shop }), lastState: { not: 'SUBSCRIBED' } },
    }),
  ]);

  const total = subscribed + unsubscribed;
  const pct =
    total > 0 ? Math.round((subscribed / total) * 100) : 0;

  return json({ subscribed, unsubscribed, total, pct });
}

export default function Dashboard() {
  const { subscribed, unsubscribed, total, pct } = useLoaderData();

  return (
    <Page title="Dashboard">
      <BlockStack gap="400">
        <InlineGrid
          columns={{ xs: 1, md: 2 }}
          gap="400"
        >
          {/* Subscribed */}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Marketable customers
              </Text>
              <Text as="p" variant="heading2xl">
                {subscribed.toLocaleString()}
              </Text>
              <InlineStack>
                <Badge tone="success">
                 {total > 0 ? `${pct}% of customers` : "No data"}
                </Badge>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Unsubscribed */}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Non-marketable customers
              </Text>
              <Text as="p" variant="heading2xl">
                {unsubscribed.toLocaleString()}
              </Text>
              <InlineStack>
                <Badge tone="critical">
                  {total > 0 ? `${100 - pct}% of customers` : "No data"}
               </Badge>
              </InlineStack>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
