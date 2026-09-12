import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // No proxy — all API calls use Tauri IPC (invoke)
  server: {
    port: 1420,
  },
  base: process.env.VITE_BASE || '/',
})
