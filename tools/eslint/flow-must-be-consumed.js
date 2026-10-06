/**
 * ESLint 规则 sgs/flow-must-be-consumed(typed):
 * 返回类型为 Flow<…>(或任何 Generator)的调用表达式必须被消费 ——
 * 作为 yield* 的操作数、return 的操作数、箭头函数的表达式体、变量初始值或赋值右侧。
 * 漏写 yield* 会让生成器静默不执行,这是本引擎最常见的 bug(ENGINE_DESIGN.md §11.4)。
 */

/** 调用表达式是否处于"被消费"的语法位置 */
function isConsumed(node) {
  const parent = node.parent
  if (!parent) return false
  switch (parent.type) {
    case 'YieldExpression':
      return parent.delegate === true
    case 'ReturnStatement':
      return true
    case 'ArrowFunctionExpression':
      return parent.body === node
    case 'VariableDeclarator':
      return parent.init === node
    case 'AssignmentExpression':
      return parent.right === node
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      return isConsumed(parent)
    default:
      return false
  }
}

/** 类型是否是 Flow 别名或 Generator */
function isFlowType(type) {
  if (type.aliasSymbol && type.aliasSymbol.getName() === 'Flow') return true
  const symbol = type.getSymbol()
  return symbol !== undefined && symbol.getName() === 'Generator'
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: '返回 Flow(生成器)的调用必须被 yield* / return / 赋值消费' },
    schema: [],
    messages: {
      unconsumed: '返回 Flow 的调用 `{{text}}` 未被消费:请写成 yield* 调用、return 它或赋值给变量',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services || !services.program || !services.esTreeNodeToTSNodeMap) return {}
    const checker = services.program.getTypeChecker()
    return {
      CallExpression(node) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node)
        if (!tsNode) return
        const type = checker.getTypeAtLocation(tsNode)
        if (!isFlowType(type) || isConsumed(node)) return
        context.report({
          node,
          messageId: 'unconsumed',
          data: { text: context.sourceCode.getText(node).slice(0, 60) },
        })
      },
    }
  },
}

export default rule
