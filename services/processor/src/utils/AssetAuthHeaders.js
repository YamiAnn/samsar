// Media elements cannot attach Authorization headers. Accept their existing
// login cookie only here; the normal account verifier still validates the token.
const explicitCredentials = /^(authorization|api_key|app_key|app-key|x-app-key|x-samsar-app-key|x-customer-sub-account-api-key|x-customer-subaccount-api-key|x-samsar-customer-sub-account-api-key|x-samsar-sub-account-api-key|customer-sub-account-api-key|customer_sub_account_api_key|x-external-user-api-key|external_user_api_key|external-user-api-key)$/i;

export function resolveAssetAuthHeaders(headers = {}) {
  if (Object.keys(headers).some(name => explicitCredentials.test(name))) return headers;
  const cookieHeader = headers.cookie || headers.Cookie;
  if (typeof cookieHeader !== 'string') return headers;
  const cookies = cookieHeader.split(';').map(value => value.trim());
  for (const name of ['authToken', 'samsarHostAuthToken']) {
    const matches = cookies.filter(value => value.startsWith(`${name}=`));
    // Ambiguous cookies must not silently select a different account.
    if (matches.length > 1) return headers;
    if (!matches.length) continue;
    try {
      const token = decodeURIComponent(matches[0].slice(name.length + 1));
      if (!token || /[\s\x00-\x1f\x7f]/.test(token)) return headers;
      return { ...headers, authorization: `Bearer ${token}` };
    } catch { return headers; }
  }
  return headers;
}
