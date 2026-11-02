/** Turns a tool's zod schema into the parameter schema the Host's plugin sandbox accepts; zod still validates each call in full. */
import { z } from 'zod'

type Node = Record<string, unknown>
function annotations(node: Node): Node {
  return { ...typeof node.description === 'string' ? { description: node.description } : {}, ...node.default !== undefined ? { default: node.default } : {} }
}
function converted(node: Node): Node {
  const variants = (node.anyOf ?? node.oneOf) as Node[] | undefined
  if (variants) {
    const real = variants.filter(variant => variant.type !== 'null')
    // A choice beyond "this or null" stays untyped for the model, whose descriptions name it, and zod checks the call.
    return real.length === 1 ? { ...converted(real[0]!), ...annotations(node) } : annotations(node)
  }
  switch (node.type) {
    case 'string': return { type: 'string', ...Array.isArray(node.enum) ? { enum: node.enum } : {}, ...annotations(node) }
    case 'number': case 'integer': case 'boolean': return { type: node.type, ...annotations(node) }
    case 'array': return node.items ? { type: 'array', items: converted(node.items as Node), ...annotations(node) } : annotations(node)
    case 'object': return node.properties ? { type: 'object', properties: properties(node), ...Array.isArray(node.required) ? { required: node.required } : {}, ...annotations(node) } : annotations(node)
    default: return annotations(node)
  }
}
const properties = (node: Node): Node => Object.fromEntries(Object.entries(node.properties as Record<string, Node>).map(([name, value]) => [name, converted(value)]))
export function toolParameters(schema: z.ZodType): Node {
  const root = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }))) as Node
  return { type: 'object', properties: root.properties ? properties(root) : {}, ...Array.isArray(root.required) ? { required: root.required } : {} }
}
