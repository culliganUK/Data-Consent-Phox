export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // ok because you are not using credentials
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Checkout-Token",
  "Access-Control-Max-Age": "600",
};

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function okJson(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function errJson(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
