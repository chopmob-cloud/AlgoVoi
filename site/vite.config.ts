import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages build uses /AlgoVoi/ base; custom domain (av.ilc-n.xyz) uses /
  base: process.env.VITE_BASE ?? (command === 'build' ? '/AlgoVoi/' : '/'),
  server: { port: 5174 },
}))
