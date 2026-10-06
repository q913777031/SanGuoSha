import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import flowMustBeConsumed from './tools/eslint/flow-must-be-consumed.js'

const sgsPlugin = { rules: { 'flow-must-be-consumed': flowMustBeConsumed } }

/** 引擎核心目录(core / events / cards)的确定性纪律:禁止 Date、Math.random、async / await / Promise、finally 内 yield */
const deterministicCore = {
  files: [
    'packages/engine/src/core/**/*.ts',
    'packages/engine/src/events/**/*.ts',
    'packages/engine/src/cards/**/*.ts',
  ],
  ignores: ['packages/engine/src/core/runner.ts'],
  rules: {
    'no-restricted-globals': ['error', { name: 'Date', message: '引擎核心禁止使用 Date(确定性)' }],
    'no-restricted-properties': [
      'error',
      {
        object: 'Math',
        property: 'random',
        message: '引擎核心禁止 Math.random,请使用 ctx.random()',
      },
    ],
    'no-restricted-syntax': [
      'error',
      { selector: 'FunctionDeclaration[async=true]', message: '引擎核心禁止 async 函数' },
      { selector: 'FunctionExpression[async=true]', message: '引擎核心禁止 async 函数' },
      { selector: 'ArrowFunctionExpression[async=true]', message: '引擎核心禁止 async 函数' },
      { selector: 'AwaitExpression', message: '引擎核心禁止 await' },
      { selector: 'NewExpression[callee.name="Promise"]', message: '引擎核心禁止 Promise' },
      { selector: 'MemberExpression[object.name="Promise"]', message: '引擎核心禁止 Promise' },
      {
        selector: 'TryStatement > BlockStatement.finalizer YieldExpression',
        message: 'finally 块内禁止 yield(GameOver 异常穿过 finally 时不得再询问)',
      },
    ],
  },
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/dev-dist/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/engine/src/**/*.ts', 'packages/engine/test/**/*.ts'],
    plugins: { sgs: sgsPlugin },
    rules: {
      'sgs/flow-must-be-consumed': 'error',
    },
  },
  deterministicCore,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
)
