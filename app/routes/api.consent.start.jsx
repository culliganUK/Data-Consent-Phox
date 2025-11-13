// app/routes/api.consent.start.js
import { json } from "@remix-run/node";
import jwt from "jsonwebtoken";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

export async function action({ request }) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  jwt.verify(token, process.env.SHOPIFY_API_SECRET, { algorithms: ["HS256"] });

  const { mode, country, variant, displayText, privacyUrl, ipCountry, marketingPreferences, billingCountry } = await request.json();
  const { session } = await authenticate.admin(request);

  const row = await prisma.consentSession.create({
    data: { shop: session.shop, mode, country, variant, displayText, privacyUrl, marketingPreferences, ipCountry, billingCountry },
    select: { id: true },
  });

  return json({ sessionId: row.id });
}
