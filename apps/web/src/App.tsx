import { ENGINE_VERSION } from '@sgs/engine'

/**
 * 应用根组件。M5 之前只显示引擎版本,用于验证构建链路。
 */
export function App() {
  return (
    <main className="app">
      <h1>三国杀</h1>
      <p>engine {ENGINE_VERSION}</p>
    </main>
  )
}
