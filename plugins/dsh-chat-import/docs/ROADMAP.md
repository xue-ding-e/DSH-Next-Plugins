# Roadmap

> 这里只列未完成、计划中，以及明确不做的事项。已经做完的部分由 git 与 CHANGELOG 记录。

## 进行中 / 观察项

- 提升 Windows 上的测试稳定性。偶发的问题集中在三类：`EPERM: rename`、临时目录竞争，以及 `rm` 语义相关的用例。
- 补写 Kimi `context.apply_compaction` 的压缩语义文档，说明只保留最后一次压缩之后的模型视角。
- 持续观察外部生态与官方能力的变化，避免重复实现已有的东西。
- opencode V2（`opencode2 session import`）的反向导出契约还没验证。目前 `export_chat({ format: 'opencode' })` 写的仍是 V1 `opencode import` 能读的 JSON（见 `architecture.md` D19）。
- opencode V2 还有几处没有真实样本：`shell` 消息、原生 `providerContext` 压缩窗口、fork（`fork_session_id` / `fork_boundary`）、revert 删除消息。拿到样本之后，再按 D19 补口径与测试。

## 明确不做

- 不提供让 Agent 自己删除导入会话的入口。删除是低频需求，而这个入口会让常驻的工具描述挤占上下文；面板「历史」页已经提供带确认的批量删除。
