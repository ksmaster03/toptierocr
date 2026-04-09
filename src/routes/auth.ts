import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { setCookie, deleteCookie } from 'hono/cookie'
import { authService } from '../services/auth.ts'
import { authMiddleware, COOKIE_NAME } from '../auth/middleware.ts'
import { env } from '../env.ts'

export const authRoutes = new Hono()

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const { username, password } = c.req.valid('json')
  try {
    const result = await authService.login(username, password)

    setCookie(c, COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: result.expiresIn,
      secure: env.NODE_ENV === 'production',
    })

    // Note: we intentionally do NOT echo the token in the JSON body —
    // browsers should rely on the HttpOnly cookie. CLI tools can grab the
    // cookie from the Set-Cookie header.
    return c.json({ user: result.user, expiresIn: result.expiresIn })
  } catch {
    return c.json({ error: 'invalid credentials' }, 401)
  }
})

authRoutes.post('/logout', (c) => {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
  return c.json({ ok: true })
})

authRoutes.get('/me', authMiddleware, (c) => {
  const user = c.get('user')
  return c.json({
    user: {
      id: user.id,
      tenantId: user.tenantId,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
    },
  })
})
