import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
  esbuild: {
    jsx: 'automatic',
  },
})
