import { eq } from 'drizzle-orm'
import { sign } from 'hono/jwt'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import { env } from '../env.ts'
import type { Role } from '../auth/middleware.ts'

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

export interface PublicUser {
  id: number
  tenantId: number
  username: string
  fullName: string
  role: Role
}

export interface LoginResult {
  token: string
  user: PublicUser
  expiresIn: number
}

export const authService = {
  async login(username: string, password: string): Promise<LoginResult> {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1)

    const user = rows[0]
    if (!user) {
      // generic error message — never reveal whether the username exists
      throw new Error('invalid credentials')
    }

    const ok = await Bun.password.verify(password, user.passwordHash)
    if (!ok) {
      throw new Error('invalid credentials')
    }

    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))

    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    const payload = {
      id: user.id,
      tenantId: user.tenantId,
      username: user.username,
      fullName: user.fullName,
      role: user.role as Role,
      exp,
    }

    const token = await sign(payload, env.JWT_SECRET)

    return {
      token,
      expiresIn: TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        username: user.username,
        fullName: user.fullName,
        role: user.role as Role,
      },
    }
  },

  async createUser(input: {
    tenantId: number
    username: string
    password: string
    fullName: string
    role: Role
  }): Promise<void> {
    const passwordHash = await Bun.password.hash(input.password)
    await db.insert(users).values({
      tenantId: input.tenantId,
      username: input.username,
      passwordHash,
      fullName: input.fullName,
      role: input.role,
    })
  },

  async findByUsername(username: string) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1)
    return rows[0]
  },
}
