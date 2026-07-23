# Reflect

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Mac と iPhone 向けのプレーンファイル型ノート：デイリーノート、Wiki リンク、
ローカル検索、そして自分の Markdown を対象にしたオプションの AI 機能。

[![Release](https://img.shields.io/github/v/release/team-reflect/reflect-open)](https://github.com/team-reflect/reflect-open/releases/latest)
[![CI](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml/badge.svg)](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reflect は、Markdown ファイルを収めたフォルダーを中心に構築された
オープンソースのノートアプリです。今日のノートを開き、`[[wiki links]]` で
人物、プロジェクト、アイデアを結び付け、ノートをアプリ専用データベースに
閉じ込めることなく高速な検索とバックリンクを維持します。

Reflect アカウントは必要ありません。ノートは自分で選んだフォルダーに保存され、
AI プロバイダー、文字起こし、iCloud、GitHub、その他の git リモートといった
オプションサービスにはユーザーが直接接続します。

<img width="2926" height="1800" alt="Reflect" src="https://github.com/user-attachments/assets/6da0e0d2-3f25-4fc4-850c-b764548c3abe" />

## 機能

- **デイリーノート：** アプリは今日のノートを開き、キャプチャーした内容は
  デフォルトでそこに追加されます。
- **Wiki リンクとバックリンク：** `[[` と入力してノートをリンクできます。
  各ノートには、そのノートへリンクしている項目が表示されます。
- **ローカル検索：** `⌘K` でノート、バックリンク、タグを検索できます。
  オプションのセマンティック検索をローカルで有効にすることもできます。
- **ノートへの質問：** `⌘J` で、ユーザーが用意した OpenAI、Anthropic、
  Google、OpenRouter のキーを使ってノートを検索できます。回答には
  参照元のノートが引用されます。
- **プライベートノート：** `private: true` を設定すると、ノートの内容が
  AI やその他の外部サービスへ送信されません。
- **オーディオメモ：** 音声を録音し、設定済みの文字起こしプロバイダーで
  デイリーノートに文字起こしします。
- **ブラウザーキャプチャー：** Chrome からリンク、選択テキスト、
  スクリーンショット、ページ本文を保存します。
- **同期方法：** iCloud Drive でファイルを同期するか、git/GitHub で
  バージョン管理されたバックアップを作成します。
- **CLI：** スクリプトやエージェントでは `reflect today`、
  `reflect search`、`reflect show` を利用できます。
  [docs/cli.md](docs/cli.md) を参照してください。

## インストール

1. **Mac アプリをインストールします。** お使いの Mac 向けの最新版をダウンロードしてください：
   - **安定版：** [Apple シリコン（M シリーズ）](https://github.com/team-reflect/reflect-open/releases/latest/download/Reflect_aarch64.dmg) · [Intel](https://github.com/team-reflect/reflect-open/releases/latest/download/Reflect_x86_64.dmg)
   - **Beta：** [Apple シリコン（M シリーズ）](https://github.com/team-reflect/reflect-open/releases/download/updater-beta/Reflect.Beta_aarch64.dmg) · [Intel](https://github.com/team-reflect/reflect-open/releases/download/updater-beta/Reflect.Beta_x86_64.dmg)

   各ビルドは署名と公証が済んでおり、GitHub Releases から自動更新されます。
   [すべてのリリースを表示](https://github.com/team-reflect/reflect-open/releases)
   することもできます。
2. **iOS Beta をインストールします。**
   [TestFlight](https://testflight.apple.com/join/j2eEz43d) に参加してください。
   iOS アプリでは、Mac アプリと同じプレーンファイルのグラフと同期方法を使用します。
3. **Chrome 拡張機能をインストールします。** Chrome ウェブストアから
   [Reflect Capture](https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd)
   を追加すると、Chrome から現在のページ、選択テキスト、スクリーンショット、
   およびオプションのページ本文を保存できます。

[ソースからビルド](#ソースからビルド)することもできます。

リリースノートは [CHANGELOG.md](CHANGELOG.md) を参照してください。

## ノートはファイル

Reflect ではノートフォルダーを**グラフ**と呼びます。グラフは、
内容の確認、バックアップ、同期、または他のツールでの編集が可能なフォルダーです：

```text
my-graph/
├── daily/2026-06-12.md     # Daily notes, named by date
├── notes/some-title.md     # Other notes, named from their titles
├── assets/                 # Images and attachments
└── audio-memos/            # Audio recordings and transcripts
```

Markdown ファイルが信頼できる唯一の情報源です。Reflect はその上に検索、
バックリンク、タグ、関連ノートを追加しますが、ファイルは引き続き
どの Markdown エディターでも使用できます。

## 同期とプライバシー

Apple デバイス間でシンプルにファイルを同期するには、
`iCloud Drive/ReflectGraph` などの iCloud 同期フォルダー内に
グラフを作成します。

バージョン管理されたバックアップや iCloud 以外の同期を利用する場合は、
アプリ内で GitHub に接続するか、
[任意の SSH git リモート](docs/generic-git-remotes.md)を追加します。
Git 同期は Markdown グラフを自分で管理するリポジトリに保存します。

デフォルトでは、ノートの内容はデバイス内に留まります。外部への通信は、
プロバイダーを設定する、git リモートに接続する、またはプラットフォームの
同期サービスを利用した後にのみ発生します。完全なプライバシーモデルについては、
[docs/privacy.md](docs/privacy.md) を参照してください。

## ソースからビルド

前提条件：

- 最新の安定版 [Rust ツールチェーン](https://rustup.rs)
- [pnpm](https://pnpm.io) 10 を備えた Node.js
- Xcode Command Line Tools

```bash
git clone https://github.com/team-reflect/reflect-open.git
cd reflect-open
corepack enable
pnpm install
pnpm tauri dev
pnpm tauri build
```

## プロジェクト構成

Reflect は pnpm/Turborepo モノレポです：

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

規約と開発ガイドについては、[CONTRIBUTING.md](CONTRIBUTING.md)、
[docs/contributing/](docs/contributing/)、[AGENTS.md](AGENTS.md) を
参照してください。

## 開発

リポジトリのルートで使用する主なコマンド：

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

iOS シミュレーターで開発する場合：

```bash
pnpm tauri:ios:dev "iPhone 17 Pro"
```

TestFlight ビルドの場合：

```bash
pnpm release:ios preflight --build-number=123
pnpm release:ios testflight --build-number=123 --wait
```

## 状況

Reflect は Beta 段階にあり、日常的に使用されています。現在は Mac アプリ、
iOS コンパニオン、ブラウザーキャプチャー、ローカルファーストの
データモデル、同期の信頼性に重点を置いています。

Windows、Android、プラグイン API は現在の対象外です。長期的な方向性は
[V2 プロダクトビジョン](docs/reflect-v2-product-vision.md)と
[docs/plans/](docs/plans/) の実装計画を参照してください。

## ライセンス

[MIT](LICENSE)。
