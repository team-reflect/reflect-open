# Reflect

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

面向 Mac 和 iPhone 的纯文件笔记：日记、Wiki 链接、本地搜索，
以及可选的、基于你自己的 Markdown 的 AI 功能。

[![Release](https://img.shields.io/github/v/release/team-reflect/reflect-open)](https://github.com/team-reflect/reflect-open/releases/latest)
[![CI](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml/badge.svg)](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reflect 是一款开源笔记应用，以一个包含 Markdown 文件的文件夹为核心。
它会打开当天的笔记，让 `[[wiki links]]` 将人物、项目和想法连接起来，
并在不把笔记变成应用专属数据库的前提下，保持搜索和反向链接的高效。

该应用不需要 Reflect 账户。笔记存放在你选择的文件夹中，
AI 提供商、转录、iCloud、GitHub 或其他 git 远程仓库等可选服务，
均由用户直接连接。

<img width="2926" height="1800" alt="Reflect" src="https://github.com/user-attachments/assets/6da0e0d2-3f25-4fc4-850c-b764548c3abe" />

## 功能

- **日记：** 应用会打开当天的笔记，且默认将捕获的内容存入其中。
- **Wiki 链接与反向链接：** 输入 `[[` 即可链接笔记；每篇笔记都会显示
  哪些内容链接到了它。
- **本地搜索：** `⌘K` 可搜索笔记、反向链接和标签。也可以启用可选的
  本地语义搜索。
- **向笔记提问：** `⌘J` 可通过用户提供的 OpenAI、Anthropic、Google
  或 OpenRouter 密钥查询笔记。回答会引用来源笔记。
- **私密笔记：** `private: true` 会阻止笔记内容被发送给 AI
  及其他外部服务。
- **音频备忘录：** 录制音频，并使用已配置的转录提供商将其转录到
  当天的笔记中。
- **浏览器捕获：** 从 Chrome 保存链接、选中的文本、截图和页面文本。
- **同步方式：** 使用 iCloud Drive 进行文件同步，或使用 git/GitHub
  进行带版本记录的备份。
- **CLI：** 脚本和智能体可使用 `reflect today`、`reflect search`
  和 `reflect show`。请参阅 [docs/cli.md](docs/cli.md)。

## 安装

1. **安装 Mac 应用。** 下载适用于你的 Mac 的最新版本：
   - **稳定版：** [Apple 芯片（M 系列）](https://github.com/team-reflect/reflect-open/releases/latest/download/Reflect_aarch64.dmg) · [Intel](https://github.com/team-reflect/reflect-open/releases/latest/download/Reflect_x86_64.dmg)
   - **Beta 版：** [Apple 芯片（M 系列）](https://github.com/team-reflect/reflect-open/releases/download/updater-beta/Reflect.Beta_aarch64.dmg) · [Intel](https://github.com/team-reflect/reflect-open/releases/download/updater-beta/Reflect.Beta_x86_64.dmg)

   每个构建版本都经过签名和公证，并通过 GitHub Releases 自动更新。
   你也可以[查看所有版本](https://github.com/team-reflect/reflect-open/releases)。
2. **安装 iOS Beta 版。** 加入
   [TestFlight](https://testflight.apple.com/join/j2eEz43d)。iOS 应用使用
   与 Mac 应用相同的纯文件图谱和同步选项。
3. **安装 Chrome 扩展程序。** 从 Chrome 应用商店添加
   [Reflect Capture](https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd)，
   即可从 Chrome 保存当前页面、选中的文本、截图和可选的页面文本。

你也可以[从源代码构建](#从源代码构建)。

版本说明请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 你的笔记就是文件

Reflect 将笔记文件夹称为**图谱**。图谱就是一个可以检查、备份、
同步或使用其他工具编辑的文件夹：

```text
my-graph/
├── daily/2026-06-12.md     # Daily notes, named by date
├── notes/some-title.md     # Other notes, named from their titles
├── assets/                 # Images and attachments
└── audio-memos/            # Audio recordings and transcripts
```

Markdown 文件是事实来源。Reflect 在其上提供搜索、反向链接、标签
和相关笔记，但这些文件仍可在任何 Markdown 编辑器中使用。

## 同步与隐私

若要在 Apple 设备间进行简单的文件同步，请在 iCloud 同步文件夹中
创建图谱，例如 `iCloud Drive/ReflectGraph`。

若要进行带版本记录的备份或非 iCloud 同步，请在应用中连接 GitHub，
或添加[任意 SSH git 远程仓库](docs/generic-git-remotes.md)。
Git 同步会将 Markdown 图谱存储在你控制的仓库中。

默认情况下，笔记内容保留在设备上。只有在你配置提供商、
连接 git 远程仓库或使用平台同步服务后，才会发起外部调用。
完整的隐私模型请参阅 [docs/privacy.md](docs/privacy.md)。

## 从源代码构建

前置要求：

- 较新的稳定版 [Rust 工具链](https://rustup.rs)
- 安装了 [pnpm](https://pnpm.io) 10 的 Node.js
- Xcode Command Line Tools

```bash
git clone https://github.com/team-reflect/reflect-open.git
cd reflect-open
corepack enable
pnpm install
pnpm tauri dev
pnpm tauri build
```

## 项目结构

Reflect 是一个 pnpm/Turborepo 单体仓库：

```text
reflect-open/
├── apps/desktop/          # Mac and iOS app
├── apps/cli/              # `reflect` CLI
├── apps/extension/        # Chrome capture extension
├── apps/native-host/      # Browser capture helper
├── packages/core/         # Shared TypeScript logic
├── packages/db/           # Database types and helpers
├── crates/index-schema/   # Shared index schema
├── design-system/         # Tokens and UI primitives
└── docs/                  # Product, architecture, and contributor docs
```

有关约定和开发指南，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)、
[docs/contributing/](docs/contributing/) 和 [AGENTS.md](AGENTS.md)。

## 开发

在仓库根目录运行的常用命令：

```bash
pnpm dev              # Vite only, http://localhost:1420
pnpm typecheck        # TypeScript
pnpm lint             # oxlint
pnpm test             # vitest; use --run path/to/test for one file
pnpm check            # typecheck + lint

# Rust tests that compile the desktop crate need sidecars staged first
pnpm --filter @reflect/desktop sidecar
cargo test --workspace
```

iOS 模拟器开发：

```bash
pnpm tauri:ios:dev "iPhone 17 Pro"
```

TestFlight 构建：

```bash
pnpm release:ios preflight --build-number=123
pnpm release:ios testflight --build-number=123 --wait
```

## 状态

Reflect 目前处于 Beta 阶段，并已用于日常工作。目前的重点是 Mac 应用、
iOS 伴侣应用、浏览器捕获、本地优先的数据模型和同步可靠性。

Windows、Android 和插件 API 目前不在范围内。长期方向请参阅
[V2 产品愿景](docs/reflect-v2-product-vision.md)和
[docs/plans/](docs/plans/) 中的实施计划。

## 许可证

[MIT](LICENSE)。
