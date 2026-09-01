/** OpenAI Codex OAuth grant parsing and refresh helpers. */

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

export interface OpenAiCodexGrant {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Decode the ChatGPT account id embedded in a Codex OAuth access token. */
export function openAiCodexAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3 || parts[1] === '') return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    if (!isObject(payload)) return null
    const auth = payload[OPENAI_AUTH_CLAIM]
    if (!isObject(auth)) return null
    const accountId = auth.chatgpt_account_id
    return typeof accountId === 'string' && accountId !== '' ? accountId : null
  } catch {
    return null
  }
}

/** Validate the opaque grant payload written by dsh-llm-pi-ai. */
export function parseOpenAiCodexGrant(payload: unknown): OpenAiCodexGrant | null {
  if (!isObject(payload) || payload.type !== 'oauth') return null
  if (typeof payload.access !== 'string' || payload.access === '') return null
  if (typeof payload.refresh !== 'string' || payload.refresh === '') return null
  if (typeof payload.expires !== 'number' || !Number.isFinite(payload.expires)) return null
  const storedAccountId = typeof payload.accountId === 'string' && payload.accountId !== '' ? payload.accountId : null
  const accountId = storedAccountId ?? openAiCodexAccountId(payload.access)
  return accountId === null
    ? null
    : { type: 'oauth', access: payload.access, refresh: payload.refresh, expires: payload.expires, accountId }
}

/** Refresh slightly early so the token cannot expire during the quota request. */
export function openAiCodexGrantNeedsRefresh(grant: OpenAiCodexGrant, now = Date.now()): boolean {
  return grant.expires <= now + 30_000
}

/** Refresh a Codex OAuth grant using the same public client identity as pi-ai. */
export async function refreshOpenAiCodexGrant(refreshToken: string, signal: AbortSignal): Promise<OpenAiCodexGrant> {
  let response: Response
  try {
    response = await fetch(OPENAI_CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`OpenAI Codex OAuth refresh failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const record = isObject(body) ? body : undefined
    const detail = record?.error_description ?? record?.error
    throw new Error(`OpenAI Codex OAuth refresh failed (HTTP ${response.status})${typeof detail === 'string' ? `: ${detail}` : ''}`)
  }
  if (!isObject(body)) throw new Error('OpenAI Codex OAuth refresh returned an invalid response')

  const access = body.access_token
  const refresh = body.refresh_token
  const expiresIn = body.expires_in
  if (typeof access !== 'string' || access === '' || typeof refresh !== 'string' || refresh === '' || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new Error('OpenAI Codex OAuth refresh response is missing token fields')
  }
  const accountId = openAiCodexAccountId(access)
  if (accountId === null) throw new Error('OpenAI Codex OAuth access token has no ChatGPT account id')
  return { type: 'oauth', access, refresh, expires: Date.now() + expiresIn * 1000, accountId }
}
