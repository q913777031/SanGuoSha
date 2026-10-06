import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** ARTIFACT=1 时构建单页预览版:不注册 Service Worker,资源用相对路径 */
const artifact = process.env.ARTIFACT === '1'

export default defineConfig({
  base: artifact ? './' : '/',
  build: artifact ? { outDir: 'dist-artifact', assetsInlineLimit: 100_000_000 } : {},
  plugins: [
    react(),
    ...(artifact
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            manifest: {
              name: '三国杀',
              short_name: '三国杀',
              description: '三国杀玩法卡牌游戏(个人自用)',
              display: 'fullscreen',
              orientation: 'landscape',
              background_color: '#0e1915',
              theme_color: '#0e1915',
              icons: [],
            },
          }),
        ]),
  ],
})
