/**
 * 把 ARTIFACT=1 的 vite 构建结果内联成单个 HTML 片段(dist-artifact/sanguosha.html),
 * 用于发布为可在手机上直接打开的预览页。用法:ARTIFACT=1 vite build && node scripts/build-artifact.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = new URL('../dist-artifact/', import.meta.url).pathname
const assets = readdirSync(join(dir, 'assets'))
const css = assets
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(dir, 'assets', f), 'utf8'))
const js = assets
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(dir, 'assets', f), 'utf8'))
if (js.length !== 1) throw new Error(`expected exactly one js bundle, got ${js.length}`)

const html = `<title>三国杀</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&family=Noto+Sans+SC:wght@400;700&display=swap">
<style>
${css.join('\n')}
</style>
<div id="root"></div>
<script type="module">
${js[0].replaceAll('</script', '<\\/script')}
</script>
`
writeFileSync(join(dir, 'sanguosha.html'), html)
process.stdout.write(`dist-artifact/sanguosha.html ${(html.length / 1024).toFixed(1)} KB\n`)
