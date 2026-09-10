# DSH Cursor Agent

在 DeepSeek Harness 中获得和 Cursor 一致的速度与体验。


直接登录 Cursor 账户或绑定 API Key / Auth Token，
在使用 Cursor 原生 Agent Loop（`agent.v1.AgentService/Run`）、标准工具、上下文压缩、自动标题等功能时，
保留 DSH 的会话、执行器和沙箱功能，

> ⚠️ 本插件接入的是 Cursor 未公开的 Agent 协议（`agent.v1.AgentService/Run`），
> 属于社区逆向工程成果，可能随 Cursor 服务端变化而失效。本项目与 Anysphere /
> Cursor 无任何关系，请遵守 Cursor 的服务条款。

## 能做什么

- 在 DSH 中直接使用 Cursor 原生 Agent Loop
- 自动发现并允许选择 Cursor 的可用模型以及思考强度、上下文等配置
- 保留 Cursor 原生工具，支持如下功能：
   - 文件读写
   - 网络请求与搜索
   - Question交互
   - 前后台Shell
   - 其他DSH工具自动被映射为mcp
- 暂未支持的：
   - PlanMode切换
   - Subagent/Task
- 使用 Cursor 原生的自动标题和上下文压缩能力，会在 Cursor Preset 里自动禁用DSH自带的自动标题、压缩，以及`billion-context-dsh` ACP
- 设置页可查看登录状态与订阅用量
- 支持修改BaseURL来使用部分中转站（不建议）

## 安装

```sh
dsh plugin --profile web add @xytoki/dsh-cursor-agent
```

## 调试

使用`CURSOR_AGENT_DEBUG=1` 开启debug log

## 致谢

修改自 [dsh-cursor-subscription](https://github.com/orrinzeng/dsh-cursor-subscription)

[MIT](LICENSE)
