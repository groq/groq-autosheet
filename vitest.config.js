import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'next/server': resolve(__dirname, 'test/mocks/next-server.js'),
    },
  },
})
