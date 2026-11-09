/** 测试直接执行 NodeNext TypeScript 源码时，把源码内部的相对 .js 引用回退到对应 .ts。 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const fromSource = typeof context.parentURL === 'string' && context.parentURL.includes('/src/')
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !fromSource || !specifier.endsWith('.js')) throw error
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
  }
}
