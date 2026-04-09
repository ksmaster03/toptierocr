import { db, pool } from './client.ts'
import { tenants, aiConfigs, users } from './schema.ts'
import { env } from '../env.ts'
import { eq } from 'drizzle-orm'
import { authService } from '../services/auth.ts'

async function seed() {
  console.log('🌱 Seeding default tenant + AI config + users...')

  const existing = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, env.DEFAULT_TENANT_ID))

  if (existing.length === 0) {
    await db.insert(tenants).values({
      id: env.DEFAULT_TENANT_ID,
      name: 'Toptier (default)',
    })
    console.log(`  ✓ Created tenant id=${env.DEFAULT_TENANT_ID}`)
  } else {
    console.log(`  • Tenant id=${env.DEFAULT_TENANT_ID} already exists`)
  }

  const existingCfg = await db
    .select()
    .from(aiConfigs)
    .where(eq(aiConfigs.tenantId, env.DEFAULT_TENANT_ID))

  if (existingCfg.length === 0) {
    await db.insert(aiConfigs).values({
      tenantId: env.DEFAULT_TENANT_ID,
      ocrProviderId: 'gemini-2.5-flash',
      fallbackProviderId: 'claude-haiku-4-5',
      fallbackThreshold: '0.80',
      monthlyBudgetThb: '1000.00',
    })
    console.log('  ✓ Created default AI config (Gemini 2.5 → Claude fallback)')
  } else {
    console.log('  • AI config already exists')
  }

  const seedUsers = [
    {
      username: 'admin',
      password: 'admin123',
      fullName: 'System Administrator',
      role: 'admin' as const,
    },
    {
      username: 'demo',
      password: 'demo123',
      fullName: 'Demo User',
      role: 'demo' as const,
    },
  ]

  for (const u of seedUsers) {
    const found = await authService.findByUsername(u.username)
    if (found) {
      console.log(`  • User '${u.username}' already exists (skip)`)
      continue
    }
    await authService.createUser({
      tenantId: env.DEFAULT_TENANT_ID,
      ...u,
    })
    console.log(`  ✓ Created user '${u.username}' (role=${u.role})`)
  }

  console.log('\n✅ Seed complete')
  console.log('   admin / admin123  → full access')
  console.log('   demo  / demo123   → documents only (Steps 1–4)')
  await pool.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
