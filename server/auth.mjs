import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_DAYS = 7
export const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null
if (publicOrigin && !publicOrigin.startsWith('https://') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicOrigin).hostname)) {
  throw new Error('PUBLIC_ORIGIN must use HTTPS outside localhost')
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex')
export const newToken = () => `nard_${randomBytes(32).toString('base64url')}`
export const newSessionToken = () => randomBytes(32).toString('base64url')
export const newId = () => randomBytes(16).toString('hex')

export function tokenMatches(given, expectedHash) {
  if (typeof given !== 'string' || !/^nard_[A-Za-z0-9_-]{43}$/.test(given) || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  return timingSafeEqual(Buffer.from(tokenHash(given), 'hex'), Buffer.from(expectedHash, 'hex'))
}

export function cookieName() {
  return publicOrigin?.startsWith('https://') ? '__Host-nard_session' : 'nard_session'
}

export function sessionCookie(token) {
  const secure = cookieName().startsWith('__Host-') ? '; Secure' : ''
  return `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`
}

export function clearSessionCookie() {
  const secure = cookieName().startsWith('__Host-') ? '; Secure' : ''
  return `${cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
}

export function cookieToken(request) {
  const cookie = request.headers.cookie || ''
  const match = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName()}=`))
  return match?.slice(cookieName().length + 1) || null
}
