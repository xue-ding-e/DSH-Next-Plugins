/**
 * Antigravity OAuth client identity.
 *
 * The pairing this file used to hard-code was a PUBLIC desktop-application OAuth
 * client — it ships inside the Antigravity desktop app and in pi-antigravity,
 * and it identifies the application, not a user. It is not committed here
 * anyway, because GitHub's push protection treats any Google OAuth client
 * secret as a leaked credential and refuses the push.
 *
 * The values are read from the environment instead. `resolveAntigravityOAuthConfig`
 * already consults `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` before
 * these defaults, so exporting them is enough to sign in:
 *
 * ```powershell
 * $env:ANTIGRAVITY_CLIENT_ID = '<id>.apps.googleusercontent.com'
 * $env:ANTIGRAVITY_CLIENT_SECRET = '<the matching app client secret>'
 * ```
 *
 * Without them the Antigravity provider reports that login is unconfigured;
 * every other provider in this plugin works normally.
 */

/** Public client id of the Antigravity desktop app; empty when not exported. */
export const ANTIGRAVITY_DEFAULT_CLIENT_ID: string = process.env.ANTIGRAVITY_CLIENT_ID?.trim() ?? ''

/** Matching client secret. Identifies the app; never a user access token. */
export const ANTIGRAVITY_DEFAULT_CLIENT_SECRET: string = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ?? ''
