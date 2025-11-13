// app/routes/app.customers.jsx
import { Outlet } from "@remix-run/react";
import { authenticate } from "~/shopify.server";

export async function loader({ request }) {
  await authenticate.admin(request);
  return null;
}

export default function CustomersLayout() {
  return <Outlet />;
}
