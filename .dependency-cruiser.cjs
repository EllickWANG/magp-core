/**
 * 边界红线(CI 强制)—— 边界做在【文件夹 + 接口】上,单进程内。
 *  1. agent(common/agent)不许依赖具体业务(business/app|cms):agent 是被业务复用的公共能力。
 *  2. engine 不许直接 import 各模块的【实现】,只许 import 各模块的 *.contract(接口 token)。
 *  3. 禁止循环依赖。
 */
module.exports = {
  forbidden: [
    {
      name: 'agent-not-depend-on-business',
      severity: 'error',
      comment: 'agent 是公共能力,不许反向依赖具体业务域。',
      from: { path: '^src/business/common/agent' },
      to: { path: '^src/business/(app|cms)' },
    },
    {
      name: 'engine-depends-on-contracts-only',
      severity: 'error',
      comment: 'engine 只认接口:不许 import 兄弟模块的实现文件,只许 import *.contract。',
      from: { path: '^src/business/common/agent/engine' },
      to: {
        path: '^src/business/common/agent/(model|tools|protocol|persistence|permission|session)/(?!.*\\.contract\\.ts$).*\\.ts$',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: '禁止循环依赖。',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
