import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        codeSplitting: true,
        manualChunks: function (id) {
          if (id.includes('tictactoe')) return 'tictactoe'
          if (id.includes('sudoku')) return 'sudoku'
          if (id.includes('ballrun')) return 'ballrun'
          if (id.includes('watersort')) return 'watersort'
          return undefined
        },
      },
    },
  },
})