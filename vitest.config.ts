import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['.dsh-dev/**', 'dist/**', 'node_modules/**'],
    pool: 'threads',
  },
})
