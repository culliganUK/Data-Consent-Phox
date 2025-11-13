// app/services/klaviyo.server.js
const BASE = "https://a.klaviyo.com/api/v2";

function withApiKey(url, key) {
  const u = new URL(url);
  u.searchParams.set("api_key", key);
  return u.toString();
}

export async function klLists(key, fetcher = fetch) {
  const res = await fetcher(withApiKey(`${BASE}/lists`, key));
  if (!res.ok) throw new Error(`Klaviyo lists failed: ${res.status}`);
  return res.json(); // [{ list_id, name }, ...]
}

export async function klListDetail(key, listId, fetcher = fetch) {
  const res = await fetcher(withApiKey(`${BASE}/list/${listId}`, key));
  if (!res.ok) throw new Error(`Klaviyo list failed: ${res.status}`);
  return res.json(); // { list_id, name, ... }
}

export async function klSubscribe(key, listId, email, opts = {}, fetcher = fetch) {
  const body = {
    profiles: [{
      email,
      $first_name: opts.firstName ?? undefined,
      $last_name:  opts.lastName ?? undefined
    }],
    confirm_optin: !!opts.confirmOptIn,
  };
  const res = await fetcher(withApiKey(`${BASE}/list/${listId}/subscribe`, key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status}`);
  return res.json();
}

export async function klRemoveFromList(key, listId, email, fetcher = fetch) {
  const body = { emails: [email] };
  const res = await fetcher(withApiKey(`${BASE}/list/${listId}/members/remove`, key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Klaviyo remove failed: ${res.status}`);
  return res.json();
}
