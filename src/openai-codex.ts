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

/**
 * Upstream verdicts that only a fresh sign-in can clear: the stored refresh
 * token is single-use, so `refresh_token_reused` means the rotation it took
 * part in was lost, and `invalid_grant` means it was revoked or expired.
 */
const REAUTH_CODES = new Set(['refresh_token_reused', 'invalid_grant', 'invalid_token'])

/**
 * Thrown when the stored grant is unrecoverable without human authorization.
 * Carries the dead refresh token so callers can latch this verdict against
 * exactly that token — a new sign-in stores a different one and clears it —
 * and carries a message meant to reach the user verbatim.
 */
export class OpenAiCodexReauthRequiredError extends Error {
  readonly code = 'OPENAI_CODEX_REAUTH_REQUIRED'
  readonly refreshToken: string

  constructor(message: string, refreshToken: string) {
    super(message)
    this.name = 'OpenAiCodexReauthRequiredError'
    this.refreshToken = refreshToken
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a failed token response. OpenAI reports a consumed refresh token as a
 * nested object (`{ error: { code: 'refresh_token_reused' } }`) while the OAuth
 * spec uses a bare `error` string, so both shapes are unwrapped into one
 * human-readable detail plus the "needs a new sign-in" verdict.
 */
function refreshFailure(body: unknown): { detail: string | undefined; reauth: boolean } {
  if (!isObject(body)) return { detail: undefined, reauth: false }
  const description = typeof body.error_description === 'string' && body.error_description !== '' ? body.error_description : undefined
  const nested = body.error
  if (isObject(nested)) {
    const message = typeof nested.message === 'string' && nested.message !== '' ? nested.message : undefined
    const code =
      typeof nested.code === 'string' && nested.code !== ''
        ? nested.code
        : typeof nested.type === 'string' && nested.type !== ''
          ? nested.type
          : undefined
    const detail = message === undefined ? code : code === undefined ? message : `${message} (${code})`
    return { detail: detail ?? description, reauth: code !== undefined && REAUTH_CODES.has(code) }
  }
  if (typeof nested === 'string' && nested !== '') {
    return { detail: description ?? nested, reauth: REAUTH_CODES.has(nested) }
  }
  return { detail: description, reauth: false }
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
    const failure = refreshFailure(body)
    const message = `OpenAI Codex OAuth refresh failed (HTTP ${response.status})${failure.detail === undefined ? '' : `: ${failure.detail}`}`
    if (failure.reauth) throw new OpenAiCodexReauthRequiredError(message, refreshToken)
    throw new Error(message)
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

/* ------------------------------------------------------------------ *
 * Grant resolution over the credentials seam
 * ------------------------------------------------------------------ */

/**
 * The slice of the harness credentials record seam this module needs. It is
 * exactly `CredentialProvider`'s record half, kept structural so the module
 * stays independent of the (separately versioned) credential typings.
 */
export interface OpenAiCodexGrantStore<Record_> {
  readRecord(key: string): Promise<Record_ | undefined>
  modifyRecord(
    key: string,
    mutate: (current: Record_ | undefined) => Promise<Record_ | undefined>,
  ): Promise<Record_ | undefined>
}

/**
 * Resolve the stored Codex grant, rotating it under the credential store's
 * exclusive lock when it is close to expiry.
 *
 * The lock is taken *before* the network round trip, not after it. The refresh
 * token is single-use upstream, so a write that fails once the token has been
 * spent loses the rotation for good; deciding inside `mutate` also means a
 * concurrent process that already rotated the grant is observed rather than
 * overwritten, and no single-use token is ever spent twice. A rejected write
 * is deliberately left to propagate — reporting a healthy panel over a grant
 * that was never persisted is what turns this failure into a silent brick.
 *
 * The record is pre-read outside the lock only to answer "is there a grant at
 * all" (missing authorization) and to keep the steady state lock-free.
 *
 * @param store - the credentials record seam.
 * @param key - the record key holding the grant.
 * @param grantRecord - rebuilds the store's own record shape around a grant.
 * @param signal - cancellation for the refresh request.
 * @returns the current grant, or `undefined` when none is stored/parseable.
 */
export async function resolveOpenAiCodexGrant<Record_ extends { kind: string; payload?: unknown }>(
  store: OpenAiCodexGrantStore<Record_>,
  key: string,
  grantRecord: (grant: OpenAiCodexGrant) => Record_,
  signal: AbortSignal,
): Promise<OpenAiCodexGrant | undefined> {
  const existing = await store.readRecord(key)
  if (existing === undefined) return undefined
  const parsed = parseOpenAiCodexGrant(existing.payload)
  if (parsed === null) return undefined
  if (!openAiCodexGrantNeedsRefresh(parsed)) return parsed

  const committed = await store.modifyRecord(key, async (current) => {
    if (current === undefined) return undefined
    const fresh = parseOpenAiCodexGrant(current.payload)
    if (fresh === null) return undefined
    // Another process — or the harness's own pi-ai adapter, which refreshes
    // the same record — may have rotated it while this call waited for the
    // lock. Declining leaves the entry untouched, per the seam's contract.
    if (!openAiCodexGrantNeedsRefresh(fresh)) return undefined
    return grantRecord(await refreshOpenAiCodexGrant(fresh.refresh, signal))
  })

  // `mutate` returning `undefined` makes the store answer with the record as
  // it stands, so the committed value is preferred over the stale snapshot.
  const settled = committed === undefined ? null : parseOpenAiCodexGrant(committed.payload)
  return settled ?? parsed
}
