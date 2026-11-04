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

## 许可证

`plugins/` 下的插件保留各自 `package.json` 和 `LICENSE` 文件声明的许可证；合集不替换这些许可证。订阅和聊天导入插件保留各自上游的署名与声明。
