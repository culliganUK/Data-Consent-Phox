// app/routes/app.api.customers.jsx
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = String(session.shop).toLowerCase();

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const state = (url.searchParams.get("state") || "").trim().toUpperCase(); // "", SUBSCRIBED, NOT_SUBSCRIBED
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const PAGE_SIZE = 20;

  const AND = [{ shop }];

  if (q) {
    AND.push({
      OR: [
        { email: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
      ],
    });
  }

  if (state === "SUBSCRIBED") {
    AND.push({ lastState: "SUBSCRIBED" });
  } else if (state === "NOT_SUBSCRIBED") {
    // combine UNSUBSCRIBED and NOT_SUBSCRIBED
    AND.push({ lastState: { in: ["UNSUBSCRIBED", "NOT_SUBSCRIBED"] } });
  }

  const where = { AND };

  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ lastConsentAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        shop: true,
        email: true,
        firstName: true,
        lastName: true,
        shopifyCustomerId: true,
        lastState: true,
        lastConsentAt: true,
      },
    }),
  ]);

  return json(
    { q, state, page, pageSize: PAGE_SIZE, total, rows },
    { headers: { "Cache-Control": "no-store" } }
  );
}
