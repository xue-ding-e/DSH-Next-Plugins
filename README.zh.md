# DSH Next 插件

[English](README.md)

本仓库独立维护供 [DSH-Next-Profile](https://github.com/xue-ding-e/DSH-Next-Profile) 使用的扩展包，包含插件代码和构建输入，与 Harness 主程序分开维护。

## 安装

先安装受支持的 DeepSeek Harness 或 DSH Next 桌面版，再使用 Profile 仓库发布的安装器安装扩展合集。本仓库的插件源码包是开发输入，Profile 安装器使用带版本的插件安装包。

## 插件

合集包含内置浏览器控制、导航侧键、键鼠操作提示、鲸鱼启动视频、BrowserSkill 桥接、重试设置、订阅接入、Qoder Connect 和聊天导入。各插件保留独立包名、版本和许可证。账号授权和本机集成配置保留在用户电脑上。

## 来源与更新

最初七个 Next 扩展来自 DSH-Next 提交 `1813d72421df0a0675df18f219d3a28cae640da7`。Qoder Connect 和聊天导入保留为独立扩展发行所收集的本机已安装修订。各目录保留来源声明和插件许可证。

本发行修改了 BrowserSkill 桥接 0.1.1，要求显式选择浏览器；Qoder Connect 0.6.1，允许经过适配测试的 0.2.1-rc.3 和 0.2.2-rc.1 宿主 API；以及聊天导入 0.26.4-fix.2，使用宿主的独占写句柄追加事件。增量导入会拒绝仍由 Agent 加载的会话；请重启 Harness，在打开该会话之前导入。这些修改保留各包的原始许可证。

更新插件时同时维护源码与已编译的浏览器／Host 文件，运行相关测试，发布新版本后再更新 Profile 配方。Profile 发布构建器校验插件输入、制作可搬移的安装包，并锁定文件哈希。Profile 发布物不得依赖开发电脑的源码目录。

## 普通聊天之间的消息投递

`plugins/dsh-session-relay` 是面向 Harness **0.2.2-rc.1** 的可选 Host 插件，独立于现有 Profile 发行锁定的九个包。它提供 `list_sessions`、`read_session`、`send_message_to_session`、`get_session_delivery`，支持分别创建的普通聊天和普通 fork。子代理继续使用原有树内通信工具。

安装时，在宿主 `plugin_manager` 工具中使用 `action: "install_bundle"`，`target` 填本插件目录的绝对路径。安装结果会说明已生效还是需要重启。在插件目录运行 `npm pack --ignore-scripts` 可以制作便携安装包；包内包含 Host 实现、bundle 补丁、清单和 MIT 许可证，唯一的包导入是宿主公开的 `@deepseek-ai/dsh-session` 导出。自带补丁选择同目录范围和仅注入上下文的投递方式。

Agent 可以这样给已有聊天发送进展：

```javascript
list_sessions({ query: "Shop" })
send_message_to_session({
  session_id: "<list_sessions 返回的目标 ID>",
  request_id: "shop-build-update-1",
  message: "Shop 构建已经通过，请在你的任务中检查回归结果。",
  delivery: "steer"
})
get_session_delivery({ session_id: "<目标 ID>", request_id: "shop-build-update-1" })
read_session({ session_id: "<目标 ID>", max_chars: 12000 })
```

`context` 将消息加入下一步输入，空闲 Agent 不会因此启动；`queue` 启动独立的后续一轮；`steer` 在下一步接收消息，空闲时启动一轮。默认是 `context`。成功回执表示 inbox 已接收并落盘，不表示目标已回复或工作已成功。投递状态为 `pending`、`claimed`、`consumed`、`cancelled`、`not-found`；`consumed` 表示输入已进入原生会话。正常销毁 Agent 或显式取消可能取消未处理输入。重试已取消的请求会得到 `DELIVERY_CANCELLED`；确需重新投递时使用新请求 ID。同一请求 ID 搭配不同正文或投递方式会得到 `REQUEST_CONFLICT`。

默认仅允许工作目录记录相同的普通聊天，并遵守原生 Remote 访问控制；在 bundle 配置设置 `scope: all` 可以允许其他目录。归档目标必须先恢复才能接收新投递。来源从真实存活的调用 Agent 获取，使用原生 `agent-message` / `relay` 标记落盘。插件复用宿主会话激活控制器、inbox、独占写句柄与 flush，不直接修改源日志或数据库。

`read_session` 返回当前模型上下文表面最近 20 条用户、跨聊天 Agent 和助手文本消息，排除运行时指令、工具、记录的推理和图片字节；它不导出压缩之前的完整历史。`max_chars` 限制完整渲染 JSON；超长消息携带 `id`、以 UTF-16 计数的 `char_offset`、`complete` 与不透明 `next_cursor`，按 id 拼接片段。会话变化使游标失效，应重新读取。列表游标是可变化列表上的偏移。消息大小按包含来源标记的完整 UTF-8 序列化输入计数。

在本仓库运行 `node --test plugins/dsh-session-relay/tests/*.test.mjs`。执行四项原生集成测试时，先将 `DSH_RELAY_TEST_HOST` 设置为已构建的 Harness 源码目录；未设置时这四项明确跳过。将 `DSH_RELAY_TEST_PACKAGE` 设置为已解包的插件目录，可以验证安装包而不是源码入口。原生测试使用临时 JSONL home、真实 Cordis Loader、生产 AgentLoop/inbox/会话查询和普通会话激活控制器；账号所有者、默认模型、工作空间输入与列表承载层使用夹具，模型返回固定响应。覆盖原生模型工具调用、忙碌接收方的下一步输入、模型可见错误、冷恢复、来源记录、取消、重试去重和卸载清理，未验证真实桌面安装、视觉渲染、跨 profile 通信与真实服务商行为。测试不读取用户历史或凭据。库代码为普通 ESM JavaScript，无需编译。

## 许可证

`plugins/` 下的插件保留各自 `package.json` 和 `LICENSE` 文件声明的许可证；合集不替换这些许可证。订阅和聊天导入插件保留各自上游的署名与声明。
