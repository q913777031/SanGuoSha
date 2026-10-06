import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '三国杀',
        short_name: '三国杀',
        description: '三国杀玩法卡牌游戏(个人自用)',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#1a1410',
        theme_color: '#1a1410',
        icons: [],
      },
    }),
  ],
})
