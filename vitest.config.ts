import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests hit a running server — bump timeout
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run integration tests serially to avoid clobbering shared DB state
    fileParallelism: false,
    reporters: ['default'],
  },
})
