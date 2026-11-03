/**
 * YAML 中的内置 plugin 短名 -> 实现模块，由应用入口装配给 Core。
 * 外部插件可通过全局 plugins 注册，或直接填写模块路径/包名，无需修改此表。
 */
export const builtinPlugins: Readonly<Record<string, string>> = Object.freeze({
  codex: new URL('./codex/index.js', import.meta.url).href,
  kubernetes: new URL('./kubernetes/index.js', import.meta.url).href,
  database: new URL('./database/index.js', import.meta.url).href,
  redis: new URL('./redis/index.js', import.meta.url).href,
  ssh: new URL('./ssh/index.js', import.meta.url).href,
  github: new URL('./github/index.js', import.meta.url).href,
  lark: new URL('./lark/index.js', import.meta.url).href,
  rest: new URL('./rest/index.js', import.meta.url).href,
});
