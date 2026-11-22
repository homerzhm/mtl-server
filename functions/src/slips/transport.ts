import {GoogleAuth} from 'google-auth-library';

export type ProviderRequest = (
  url: string, body: unknown, signal: AbortSignal, headers?: Record<string, string>,
) => Promise<unknown>;
export type GoogleRequest = (url: string, options?: RequestInit) => Promise<Response>;

export class RemoteFailure extends Error {
  constructor(readonly status: number) { super('Slip dependency request failed'); }
}

export async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new RemoteFailure(response.status);
  }
  return response.json();
}

export function googleTransport(): GoogleRequest {
  const auth = new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']});
  return async (url, options) => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error('Slip runtime credentials unavailable');
    const headers = new Headers(options?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (options?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetch(url, {...options, headers, redirect: 'error'});
  };
}
