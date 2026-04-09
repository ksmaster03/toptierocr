import type { Context, Next } from 'hono'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { env } from '../env.ts'

export type Role = 'admin' | 'demo'

export interface AuthUser {
  id: number
  tenantId: number
  username: string
  fullName: string
  role: Role
  /** JWT exp claim, seconds since epoch */
  exp: number
}

// Tell Hono what we put in c.var via c.set('user', ...)
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
  }
}

export const COOKIE_NAME = 'auth'

/**
 * Reads the JWT from cookie (preferred) or Authorization: Bearer header.
 * On success populates c.var.user. On failure returns 401.
 */
export const authMiddleware = async (c: Context, next: Next) => {
  const cookieToken = getCookie(c, COOKIE_NAME)
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const token = cookieToken || bearer
  if (!token) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  try {
    const payload = (await verify(token, env.JWT_SECRET, 'HS256')) as unknown as AuthUser
    c.set('user', payload)
    await next()
  } catch (err) {
    if (env.NODE_ENV !== 'production') {
      console.warn('[auth] verify failed:', (err as Error).message)
    }
    return c.json({ error: 'invalid or expired token' }, 401)
  }
}

/**
 * Must run AFTER authMiddleware. Allows the request only if the user has
 * one of the listed roles.
 */
export const requireRole = (...roles: Role[]) => {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as AuthUser | undefined
    if (!user) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (!roles.includes(user.role)) {
      return c.json(
        { error: 'forbidden', need: roles, have: user.role },
        403,
      )
    }
    await next()
  }
}
