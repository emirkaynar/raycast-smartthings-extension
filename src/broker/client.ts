import { fetchJson } from "../shared/http";

export type PairResponse = {
  pairId: string;
  authorizationUrl: string;
  expiresInSeconds: number;
};

export type PairStatusResponse = {
  status: "pending" | "completed" | "error";
  sessionToken?: string;
  error?: string;
};

export type AccessTokenResponse = {
  accessToken: string;
  expiresAt: string;
};

export async function createPair(brokerBaseUrl: string): Promise<PairResponse> {
  return fetchJson<PairResponse>(`${brokerBaseUrl}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

export async function getPairStatus(brokerBaseUrl: string, pairId: string): Promise<PairStatusResponse> {
  return fetchJson<PairStatusResponse>(`${brokerBaseUrl}/v1/pair/${encodeURIComponent(pairId)}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

export async function getBrokerAccessToken(brokerBaseUrl: string, sessionToken: string): Promise<AccessTokenResponse> {
  return fetchJson<AccessTokenResponse>(`${brokerBaseUrl}/v1/access-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
}

export async function brokerLogout(brokerBaseUrl: string, sessionToken: string): Promise<void> {
  await fetchJson(`${brokerBaseUrl}/v1/logout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
  });
}
