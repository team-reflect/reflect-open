# Changelog

## [0.7.0-beta.13](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.12...v0.7.0-beta.13) (2026-07-21)


### Bug Fixes

* accept Anthropic API keys from orgs that disallow browser CORS requests ([#879](https://github.com/team-reflect/reflect-open/issues/879)) ([15b6f13](https://github.com/team-reflect/reflect-open/commit/15b6f13a21d9bb2e097db57138c31b0e766448db))
* clicking a daily note's date heading focuses the note ([#904](https://github.com/team-reflect/reflect-open/issues/904)) ([2cbe463](https://github.com/team-reflect/reflect-open/commit/2cbe463e5302e9eca8282947eade40f7de5ab7df))
* make page breaks visible in the editor ([#850](https://github.com/team-reflect/reflect-open/issues/850)) ([2a48e03](https://github.com/team-reflect/reflect-open/commit/2a48e033ca5adfc4ef66126e559fe87f1ff46304))
* preserve safe editor transform diagnostics ([#851](https://github.com/team-reflect/reflect-open/issues/851)) ([628c2c7](https://github.com/team-reflect/reflect-open/commit/628c2c7077cefe0dcf08add03dd955b915e06533))
* show tagged daily notes in all notes ([#897](https://github.com/team-reflect/reflect-open/issues/897)) ([0fa6db0](https://github.com/team-reflect/reflect-open/commit/0fa6db01261c836f6d5c932e0407e52a1c9515fc))

## [0.7.0-beta.12](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.11...v0.7.0-beta.12) (2026-07-19)


### Features

* **mobile:** add AI provider consent block ([#891](https://github.com/team-reflect/reflect-open/issues/891)) ([595a215](https://github.com/team-reflect/reflect-open/commit/595a2157d920cba258a93180c2bc44e22188efe4))


### Bug Fixes

* fetch link previews like a normal browser request ([#886](https://github.com/team-reflect/reflect-open/issues/886)) ([cab03fb](https://github.com/team-reflect/reflect-open/commit/cab03fb324984d88dfb72a553e767a8db615e5ee))
* update meowdown to ^0.55.1 ([#865](https://github.com/team-reflect/reflect-open/issues/865)) ([71e2fe9](https://github.com/team-reflect/reflect-open/commit/71e2fe90f29db3372020dfec317b2c9d384b0d6e))

## [0.7.0-beta.11](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.10...v0.7.0-beta.11) (2026-07-18)


### Bug Fixes

* retry rate-limited link previews and clean up share-sheet titles ([#884](https://github.com/team-reflect/reflect-open/issues/884)) ([dfb6d29](https://github.com/team-reflect/reflect-open/commit/dfb6d29d3d76a1de088016f290cc8966da69bdfc))

## [0.7.0-beta.10](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.9...v0.7.0-beta.10) (2026-07-17)


### Bug Fixes

* enrich shared links before AI finishes ([#877](https://github.com/team-reflect/reflect-open/issues/877)) ([74a137b](https://github.com/team-reflect/reflect-open/commit/74a137b90e23c9d56b24aa6ee4caf9ca8acd24a9))

## [0.7.0-beta.9](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.8...v0.7.0-beta.9) (2026-07-17)


### Features

* format audio transcriptions automatically ([#873](https://github.com/team-reflect/reflect-open/issues/873)) ([c994a2e](https://github.com/team-reflect/reflect-open/commit/c994a2ee2d803a1b751303c67aacac6e2dfb6a4e))


### Bug Fixes

* enrich URL-only mobile link captures ([#872](https://github.com/team-reflect/reflect-open/issues/872)) ([88f163b](https://github.com/team-reflect/reflect-open/commit/88f163bb679d84d267c0005d2ad04323034e61a4))

## [0.7.0-beta.8](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.7...v0.7.0-beta.8) (2026-07-17)


### Bug Fixes

* allow linking notes whose titles contain wikilinks ([#864](https://github.com/team-reflect/reflect-open/issues/864)) ([8332444](https://github.com/team-reflect/reflect-open/commit/8332444f3242f6c68ee42cbbcdb11740378d41f2))
* preserve note aliases in links and backlinks ([#861](https://github.com/team-reflect/reflect-open/issues/861)) ([cb1a3dc](https://github.com/team-reflect/reflect-open/commit/cb1a3dc48945c486042b28555579b11ded5a2d4f))

## [0.7.0-beta.7](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.6...v0.7.0-beta.7) (2026-07-16)


### Bug Fixes

* update meowdown to ^0.52.2 ([#853](https://github.com/team-reflect/reflect-open/issues/853)) ([49546ee](https://github.com/team-reflect/reflect-open/commit/49546ee1bb7bb636e0cbcdf70863bdeb325600f9))

## [0.7.0-beta.6](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.5...v0.7.0-beta.6) (2026-07-16)


### Bug Fixes

* prevent macOS iCloud launch crashes ([#846](https://github.com/team-reflect/reflect-open/issues/846)) ([df42bd8](https://github.com/team-reflect/reflect-open/commit/df42bd80c3759fac526fe729a0a59f3eaae9f4bc))
* update meowdown to ^0.52.1 ([#847](https://github.com/team-reflect/reflect-open/issues/847)) ([aee87be](https://github.com/team-reflect/reflect-open/commit/aee87bebbe91a5495949e900644958e8fad6335c))

## [0.7.0-beta.5](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.4...v0.7.0-beta.5) (2026-07-16)


### Features

* add a smooth caret animation setting ([#840](https://github.com/team-reflect/reflect-open/issues/840)) ([bc1f201](https://github.com/team-reflect/reflect-open/commit/bc1f2012476cd82f7f2ef6d4294bcccca968af28))
* render Mermaid code blocks ([#841](https://github.com/team-reflect/reflect-open/issues/841)) ([a7b7c8d](https://github.com/team-reflect/reflect-open/commit/a7b7c8dd3d320d87d7c48ed2e905be08aee6030c))


### Bug Fixes

* update meowdown to ^0.51.0 ([#837](https://github.com/team-reflect/reflect-open/issues/837)) ([41b6a85](https://github.com/team-reflect/reflect-open/commit/41b6a8507fcc7e03496fbeb7afd75e5eec546c74))

## [0.7.0-beta.4](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.3...v0.7.0-beta.4) (2026-07-16)


### Bug Fixes

* rename GitHub backup to GitHub sync in settings ([#830](https://github.com/team-reflect/reflect-open/issues/830)) ([69a3a29](https://github.com/team-reflect/reflect-open/commit/69a3a29817668275261b7b967b62576571b26955))

## [0.7.0-beta.3](https://github.com/team-reflect/reflect-open/compare/v0.7.0-beta.2...v0.7.0-beta.3) (2026-07-15)


### Bug Fixes

* let the Mac close button hide the app ([#811](https://github.com/team-reflect/reflect-open/issues/811)) ([df0e6fa](https://github.com/team-reflect/reflect-open/commit/df0e6fa7a7fbffd491f6386b439952589f6b8ef0))

## [0.7.0-beta.2](https://github.com/team-reflect/reflect-open/compare/v0.6.1-beta.2...v0.7.0-beta.2) (2026-07-15)


### Features

* configure AI chat system prompts ([#775](https://github.com/team-reflect/reflect-open/issues/775)) ([091519d](https://github.com/team-reflect/reflect-open/commit/091519d926148afe996997934f459b4e8251daf7))


### Bug Fixes

* allow changing AI provider default models ([#810](https://github.com/team-reflect/reflect-open/issues/810)) ([554bdea](https://github.com/team-reflect/reflect-open/commit/554bdeade18031744af8207870d079c895c2438a))
* keep app running when closing Mac window ([#808](https://github.com/team-reflect/reflect-open/issues/808)) ([e98f4d3](https://github.com/team-reflect/reflect-open/commit/e98f4d36dae621e182cf92f25b443e18bbfea321))

## [0.6.1-beta.2](https://github.com/team-reflect/reflect-open/compare/v0.6.1-beta.1...v0.6.1-beta.2) (2026-07-14)


### Bug Fixes

* update meowdown to ^0.50.0 ([#798](https://github.com/team-reflect/reflect-open/issues/798)) ([559de5c](https://github.com/team-reflect/reflect-open/commit/559de5cf98800228c8e149cc78d252546cd345fb))

## [0.6.1-beta.1](https://github.com/team-reflect/reflect-open/compare/v0.6.1-beta...v0.6.1-beta.1) (2026-07-14)


### Bug Fixes

* update meowdown to ^0.49.0 ([#796](https://github.com/team-reflect/reflect-open/issues/796)) ([2d1f91a](https://github.com/team-reflect/reflect-open/commit/2d1f91ad218e10fff5c7dd26a0911e8f34f5a655))

## [0.6.1-beta](https://github.com/team-reflect/reflect-open/compare/v0.6.0...v0.6.1-beta) (2026-07-14)


### Bug Fixes

* capture iOS audio memos from Bluetooth headsets ([#789](https://github.com/team-reflect/reflect-open/issues/789)) ([8a4e2ea](https://github.com/team-reflect/reflect-open/commit/8a4e2eaa6f04283c3a1669893b45e1d5655f64a2))

## [0.6.0-beta.17](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.16...v0.6.0-beta.17) (2026-07-13)


### Bug Fixes

* complete releases after GitHub visibility delays ([#783](https://github.com/team-reflect/reflect-open/issues/783)) ([a3e913d](https://github.com/team-reflect/reflect-open/commit/a3e913d3e46f0c49a191bcf68b1cc2d97a6fb593))

## [0.6.0-beta.16](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.15...v0.6.0-beta.16) (2026-07-13)


### Bug Fixes

* keep Apple Silicon releases Xcode-compatible ([a1c17ad](https://github.com/team-reflect/reflect-open/commit/a1c17ad2fa3fb916b719322cf6f9648555157627))

## [0.6.0-beta.15](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.14...v0.6.0-beta.15) (2026-07-13)


### Bug Fixes

* find draft GitHub releases ([c2fc801](https://github.com/team-reflect/reflect-open/commit/c2fc801178212fa1ae5240b7012165418b225fd5))

## [0.6.0-beta.14](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.13...v0.6.0-beta.14) (2026-07-13)


### Features

* add clear actions to mobile search fields ([#773](https://github.com/team-reflect/reflect-open/issues/773)) ([bf041b1](https://github.com/team-reflect/reflect-open/commit/bf041b177298b760689a8fd9c83ddcbcf036ace3))


### Bug Fixes

* keep macOS installer links current ([#776](https://github.com/team-reflect/reflect-open/issues/776)) ([fa0095a](https://github.com/team-reflect/reflect-open/commit/fa0095a69c4b3f0a89201183933f5abb3f717d57))

## [0.6.0-beta.13](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.12...v0.6.0-beta.13) (2026-07-12)


### Bug Fixes

* polish the backlink hover preview card design ([#771](https://github.com/team-reflect/reflect-open/issues/771)) ([0fceefe](https://github.com/team-reflect/reflect-open/commit/0fceefe1b79963305979871c5b506a7455037fe3))
* update meowdown to ^0.47.0 ([#770](https://github.com/team-reflect/reflect-open/issues/770)) ([1369af4](https://github.com/team-reflect/reflect-open/commit/1369af4ba8be3f6bf9f21a696c3eb6454b358bbd))

## [0.6.0-beta.12](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.11...v0.6.0-beta.12) (2026-07-12)


### Features

* add backlink hover previews ([#768](https://github.com/team-reflect/reflect-open/issues/768)) ([16c8b4f](https://github.com/team-reflect/reflect-open/commit/16c8b4f7b8a5d952391f76a174431b6707604406))


### Bug Fixes

* keep notes with many backlinks responsive ([#767](https://github.com/team-reflect/reflect-open/issues/767)) ([4ec5a69](https://github.com/team-reflect/reflect-open/commit/4ec5a694001c7023182a06653c30febdd274465f))
* **mobile:** show task context grouping ([#769](https://github.com/team-reflect/reflect-open/issues/769)) ([072f3f6](https://github.com/team-reflect/reflect-open/commit/072f3f6519fac652b5bb16a3d7beb7bf97a13f2a))
* update meowdown to ^0.45.1 ([#759](https://github.com/team-reflect/reflect-open/issues/759)) ([6e0f159](https://github.com/team-reflect/reflect-open/commit/6e0f1593236dffcf3b8302cd898e4903c72a4762))
* update meowdown to ^0.46.0 ([#766](https://github.com/team-reflect/reflect-open/issues/766)) ([a2edb38](https://github.com/team-reflect/reflect-open/commit/a2edb38deb2547df8566f378d4ffd62ee671609b))

## [0.6.0-beta.11](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.10...v0.6.0-beta.11) (2026-07-12)


### Features

* add Claude Sonnet 5 to AI chat ([#762](https://github.com/team-reflect/reflect-open/issues/762)) ([5e9f277](https://github.com/team-reflect/reflect-open/commit/5e9f277aa4db140b3a58e544d8072f9e2cb5cece))

## [0.6.0-beta.10](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.9...v0.6.0-beta.10) (2026-07-12)


### Features

* add GPT-5.6 models to AI chat ([#760](https://github.com/team-reflect/reflect-open/issues/760)) ([7fd7826](https://github.com/team-reflect/reflect-open/commit/7fd782627c9408b6aaac04357b7cc5ab53a9cf2c))


### Bug Fixes

* **desktop:** soften the sidebar resize handle hover ([#753](https://github.com/team-reflect/reflect-open/issues/753)) ([9a3b3ad](https://github.com/team-reflect/reflect-open/commit/9a3b3ad510e6d29d7336a8a5f4a322aff4335391))
* scroll to the caret when it sits on a backlink ([#758](https://github.com/team-reflect/reflect-open/issues/758)) ([1b29144](https://github.com/team-reflect/reflect-open/commit/1b29144f1b981235fda47823738eba0c1e796472))

## [0.6.0-beta.9](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.8...v0.6.0-beta.9) (2026-07-11)


### Features

* **desktop:** drag to resize the sidebar and context panel ([#751](https://github.com/team-reflect/reflect-open/issues/751)) ([1b448a2](https://github.com/team-reflect/reflect-open/commit/1b448a245dfa85a16ebf142c7fdf67007171837f))


### Bug Fixes

* backlink audio memos and links from daily notes ([#745](https://github.com/team-reflect/reflect-open/issues/745)) ([98eb22f](https://github.com/team-reflect/reflect-open/commit/98eb22f4eff8372b1d777836067c56940c7411a5))
* make sidebar toggling keyboard-first ([#749](https://github.com/team-reflect/reflect-open/issues/749)) ([276906e](https://github.com/team-reflect/reflect-open/commit/276906e01acba961d6fe334db39163f4806c7818))
* update meowdown to ^0.44.1 ([#743](https://github.com/team-reflect/reflect-open/issues/743)) ([d47005a](https://github.com/team-reflect/reflect-open/commit/d47005a55b16c256cd2906052132e0d8d7ce8e6b))

## [0.6.0-beta.8](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.7...v0.6.0-beta.8) (2026-07-11)


### Features

* **desktop:** open note references in new windows ([#731](https://github.com/team-reflect/reflect-open/issues/731)) ([05432b8](https://github.com/team-reflect/reflect-open/commit/05432b81511ccd753b160d5a9c5cfcd144633a10))


### Bug Fixes

* harden cross-device title resolution ([#744](https://github.com/team-reflect/reflect-open/issues/744)) ([25edd7e](https://github.com/team-reflect/reflect-open/commit/25edd7ece954e2dadbc4421311f94783b04741d7))
* highlight note titles in mobile search ([#733](https://github.com/team-reflect/reflect-open/issues/733)) ([c0a2e03](https://github.com/team-reflect/reflect-open/commit/c0a2e03c6dff95bea1fe5ee0017ef2604c65ed31))
* keep Return-created tasks in their groups ([#727](https://github.com/team-reflect/reflect-open/issues/727)) ([ec47836](https://github.com/team-reflect/reflect-open/commit/ec47836975fdced5547310225a8c4183f31b4246))
* prevent emoji title loss and link duplicates ([#696](https://github.com/team-reflect/reflect-open/issues/696)) ([eeeb4de](https://github.com/team-reflect/reflect-open/commit/eeeb4de38676c0692fb07960a30f541e82aa843c))
* restore mobile checklist and task toolbar cycle ([#730](https://github.com/team-reflect/reflect-open/issues/730)) ([76e02b1](https://github.com/team-reflect/reflect-open/commit/76e02b17d82cc2b1d25c485fc10560d09c81dc32))

## [0.6.0-beta.7](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.6...v0.6.0-beta.7) (2026-07-11)


### Bug Fixes

* **mobile:** show the Settings version without the prerelease tag ([#741](https://github.com/team-reflect/reflect-open/issues/741)) ([2d3f1d7](https://github.com/team-reflect/reflect-open/commit/2d3f1d7d23db1f1f6fecb0055ddc69f3ae7cf5eb))
* update meowdown to ^0.43.0 ([#737](https://github.com/team-reflect/reflect-open/issues/737)) ([fb1c6f6](https://github.com/team-reflect/reflect-open/commit/fb1c6f624e7fefaa3b36223abb1f4ada2ef0bca6))

## [0.6.0-beta.6](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.5...v0.6.0-beta.6) (2026-07-11)


### Features

* add an App Review demo key for audio memo and mobile key-setup guidance ([#735](https://github.com/team-reflect/reflect-open/issues/735)) ([654f1a4](https://github.com/team-reflect/reflect-open/commit/654f1a440ef7f2126d7470bb64b2b9cddc2b781d))

## [0.6.0-beta.5](https://github.com/team-reflect/reflect-open/compare/v0.6.0-beta.4...v0.6.0-beta.5) (2026-07-10)


### Features

* add hybrid option to markdown syntax setting ([#340](https://github.com/team-reflect/reflect-open/issues/340)) ([1c6d1ae](https://github.com/team-reflect/reflect-open/commit/1c6d1ae7d9e1efdf1fc6bc9772c257c2a56f880c))
* add ISO date display option ([#424](https://github.com/team-reflect/reflect-open/issues/424)) ([6fb6de9](https://github.com/team-reflect/reflect-open/commit/6fb6de993888fc70cfc0cd87b6adc7094476a1e8))
* add OpenRouter AI provider ([#472](https://github.com/team-reflect/reflect-open/issues/472)) ([4ae1502](https://github.com/team-reflect/reflect-open/commit/4ae1502fc5ba8576518f0a07e8e95bd1a72f4a2b))
* adopt meowdown layered theme and simplify editor CSS overrides ([#442](https://github.com/team-reflect/reflect-open/issues/442)) ([a71134e](https://github.com/team-reflect/reflect-open/commit/a71134ea824cd1dddeca3fcb559dc3cf6cc41c27))
* AI menu and prompts on the editor selection ([#459](https://github.com/team-reflect/reflect-open/issues/459)) ([c67a650](https://github.com/team-reflect/reflect-open/commit/c67a650cdf8aa1a99c4b1f2df3d3991c6b83bc5d))
* Apple Calendar integration — events beside the daily note ([#454](https://github.com/team-reflect/reflect-open/issues/454)) ([cdd9a96](https://github.com/team-reflect/reflect-open/commit/cdd9a9671c57fdab12d0c37dc0bbabe2fb5e7c45))
* Apple Contacts integration ([#456](https://github.com/team-reflect/reflect-open/issues/456)) ([10a9f28](https://github.com/team-reflect/reflect-open/commit/10a9f287fe87114495f0d4cfcb1444cfcbb08fb4))
* **assets:** AI description files for images and PDFs (Plan 20) ([#257](https://github.com/team-reflect/reflect-open/issues/257)) ([148d54e](https://github.com/team-reflect/reflect-open/commit/148d54e7208503d1e221091baa1e8421a6966738))
* attendee autocomplete in the add-meeting dialog; Events below Note actions ([#489](https://github.com/team-reflect/reflect-open/issues/489)) ([b6145f4](https://github.com/team-reflect/reflect-open/commit/b6145f48fa72bf584d246878377e6bf9541b6197))
* **backlinks:** toggle task checkboxes in snippets through to the source note ([#608](https://github.com/team-reflect/reflect-open/issues/608)) ([0af0e9e](https://github.com/team-reflect/reflect-open/commit/0af0e9efd2be328a6cfd33109687c3a84a952fd7))
* **backup:** make "grant repo access" a first-class connect step ([#367](https://github.com/team-reflect/reflect-open/issues/367)) ([82230e7](https://github.com/team-reflect/reflect-open/commit/82230e70ae0cb415092329e82b972f0f556c4233))
* **chat:** let AI chat read asset descriptions via read_assets ([#630](https://github.com/team-reflect/reflect-open/issues/630)) ([88ba753](https://github.com/team-reflect/reflect-open/commit/88ba7534b948aa0107aad12c9f5086209e114d06))
* delete a graph to the trash from settings ([#524](https://github.com/team-reflect/reflect-open/issues/524)) ([2a373ec](https://github.com/team-reflect/reflect-open/commit/2a373ec8bf909438099f277e418da97601f5adad))
* **desktop:** ⌘-click a note link opens it in a new window ([#560](https://github.com/team-reflect/reflect-open/issues/560)) ([aa316a7](https://github.com/team-reflect/reflect-open/commit/aa316a76b27c5ca1749f4f6a7be12a45280e1bc3))
* **desktop:** color-coded conflict view with matching resolve buttons ([#601](https://github.com/team-reflect/reflect-open/issues/601)) ([2e457a2](https://github.com/team-reflect/reflect-open/commit/2e457a2009425e3a70496a41776182040b9893ca))
* **desktop:** download Firebase attachments during Reflect V1 import ([#602](https://github.com/team-reflect/reflect-open/issues/602)) ([6de1209](https://github.com/team-reflect/reflect-open/commit/6de120923d30ef70c11d013da876619fa614caa2))
* **desktop:** import Reflect V1 exports from settings ([#516](https://github.com/team-reflect/reflect-open/issues/516)) ([7e3a3ad](https://github.com/team-reflect/reflect-open/commit/7e3a3ad0324b56cbdf0aee68f82d675711d77a24))
* **desktop:** make Daily capture arrivals append at today's end ([#597](https://github.com/team-reflect/reflect-open/issues/597)) ([d6e887e](https://github.com/team-reflect/reflect-open/commit/d6e887e18fe2080834de1697c237855c56512a8a))
* **desktop:** open All Notes filtered by tag on `#tag` click ([#355](https://github.com/team-reflect/reflect-open/issues/355)) ([ab9870f](https://github.com/team-reflect/reflect-open/commit/ab9870f66323769af18d50092213431d6257bd57))
* **desktop:** open the selected note in a new window ([#723](https://github.com/team-reflect/reflect-open/issues/723)) ([cab2feb](https://github.com/team-reflect/reflect-open/commit/cab2feb7b3ef4ed0cbc57b1103d9f621f911826b))
* **desktop:** polish the graph chooser and mobile onboarding UX ([#525](https://github.com/team-reflect/reflect-open/issues/525)) ([c396ac7](https://github.com/team-reflect/reflect-open/commit/c396ac7237369f04d5e887c885db3db2eed0dc5e))
* **desktop:** press ArrowUp/ArrowDown to cross the editor boundary ([#397](https://github.com/team-reflect/reflect-open/issues/397)) ([d1b9c85](https://github.com/team-reflect/reflect-open/commit/d1b9c8544c78bd3b0c4d0aaeb57315585998c1b2))
* **editor:** enable meowdown block handle in notes ([#296](https://github.com/team-reflect/reflect-open/issues/296)) ([c70512f](https://github.com/team-reflect/reflect-open/commit/c70512fb360bb070d5f7f0aa17cdd871b896b19e))
* enforce the notes kind/daily_date invariant at the schema level ([#467](https://github.com/team-reflect/reflect-open/issues/467)) ([ab50744](https://github.com/team-reflect/reflect-open/commit/ab5074418de55081d4a8e46bb68e9ed29195dc75))
* file attachments — paste/drop/attach arbitrary files into notes ([#457](https://github.com/team-reflect/reflect-open/issues/457)) ([39511e6](https://github.com/team-reflect/reflect-open/commit/39511e6bafb9a5362bda8b5921b5122553f69a74))
* iCloud Drive sync — foundations, conflict resolution, and app wiring (Plan 21, Phases 0–4) ([#501](https://github.com/team-reflect/reflect-open/issues/501)) ([546b30b](https://github.com/team-reflect/reflect-open/commit/546b30bfaeed81dcfa923840566e1b56115c6aad))
* incoming-backlinks section on mobile note surfaces ([#482](https://github.com/team-reflect/reflect-open/issues/482)) ([5a2526e](https://github.com/team-reflect/reflect-open/commit/5a2526e4a295322dc6eccb63ab3f1f36166bcebf))
* integrate shadcn chat components ([#420](https://github.com/team-reflect/reflect-open/issues/420)) ([ab10e2c](https://github.com/team-reflect/reflect-open/commit/ab10e2c3bbef7b1350f92953c10bdf3f455cac61))
* **ios:** connect GitHub sync for the local graph ([#559](https://github.com/team-reflect/reflect-open/issues/559)) ([e07b23e](https://github.com/team-reflect/reflect-open/commit/e07b23e5e8e285b7a87a23191e52942a02d2a34b))
* **ios:** dedicated settings screen and iOS-style graph switcher ([#536](https://github.com/team-reflect/reflect-open/issues/536)) ([1ab482c](https://github.com/team-reflect/reflect-open/commit/1ab482cf0de2eb032675e9500b64a043aadd87dc))
* **ios:** land the daily double-tap caret at the end of today's note ([#557](https://github.com/team-reflect/reflect-open/issues/557)) ([23e1f97](https://github.com/team-reflect/reflect-open/commit/23e1f975d2a64df8f5f21ca4d5d9ce2f21c13c63))
* **ios:** markdown editor + add-flow autofocus in the task quick-edit sheet ([#547](https://github.com/team-reflect/reflect-open/issues/547)) ([355c7cc](https://github.com/team-reflect/reflect-open/commit/355c7ccca1e1787be0b81c2f69c86ba9cd7c9071))
* **ios:** save links from the share sheet (App Group capture inbox) ([#520](https://github.com/team-reflect/reflect-open/issues/520)) ([2996d6c](https://github.com/team-reflect/reflect-open/commit/2996d6c2b0086e40a46652f7ef41eb151c2f62d3))
* keep local Git history for graphs without a backup remote ([#610](https://github.com/team-reflect/reflect-open/issues/610)) ([19cfa73](https://github.com/team-reflect/reflect-open/commit/19cfa73eca7fa01b9cc954299db35d527aeb14c4))
* let ios create iCloud graphs ([#514](https://github.com/team-reflect/reflect-open/issues/514)) ([f282ab9](https://github.com/team-reflect/reflect-open/commit/f282ab9b0894be5717aad43264130be9043e7198))
* light impact haptics for mobile date and tab taps ([#479](https://github.com/team-reflect/reflect-open/issues/479)) ([abb83ff](https://github.com/team-reflect/reflect-open/commit/abb83ff08e8bb12b07a571df6912581f46a07ce6))
* mobile editor input hygiene, focus contract, and touch affordances ([#477](https://github.com/team-reflect/reflect-open/issues/477)) ([d2dd15c](https://github.com/team-reflect/reflect-open/commit/d2dd15cc0e3e251cfd66a3b93ff2f3b118c5f766))
* mobile sync slice — foreground cycles, background flush, live status (Plan 19 step 10) ([#483](https://github.com/team-reflect/reflect-open/issues/483)) ([b5e3969](https://github.com/team-reflect/reflect-open/commit/b5e3969c6803120ad070d7e16f574f68a23df436))
* **mobile:** All-tab double-tap focuses search, search key dismisses keyboard ([#627](https://github.com/team-reflect/reflect-open/issues/627)) ([51bf802](https://github.com/team-reflect/reflect-open/commit/51bf80255d0f88c34bd1d911826829d9a9143517))
* **mobile:** month picker sheet and rolling month title on the daily strip ([#585](https://github.com/team-reflect/reflect-open/issues/585)) ([e654c67](https://github.com/team-reflect/reflect-open/commit/e654c675d6138eb866f4c20b947b18c69271b149))
* **mobile:** port the AI chat to iOS as a Chat tab (Plan 23) ([#564](https://github.com/team-reflect/reflect-open/issues/564)) ([c2dee0a](https://github.com/team-reflect/reflect-open/commit/c2dee0a74810d537ad207bab1c3f3cab218a6817))
* **mobile:** slide the calendar strip's selection circle between days ([#587](https://github.com/team-reflect/reflect-open/issues/587)) ([07d5bd0](https://github.com/team-reflect/reflect-open/commit/07d5bd075f452341ba4762ef3a89e49256ce26e2))
* **mobile:** Tasks tab — desktop task data with a touch surface ([#518](https://github.com/team-reflect/reflect-open/issues/518)) ([554fecb](https://github.com/team-reflect/reflect-open/commit/554fecb0c70a2c681510ee45a1f8152a11e5fafa))
* native push/pop transitions and edge back-swipe for the mobile shell ([#485](https://github.com/team-reflect/reflect-open/issues/485)) ([ffb8231](https://github.com/team-reflect/reflect-open/commit/ffb8231b34db9ff3aa0b9daac7d7ec04fbb57c4e))
* note templates — templates/ folder, palette insertion, settings management ([#458](https://github.com/team-reflect/reflect-open/issues/458)) ([eff075f](https://github.com/team-reflect/reflect-open/commit/eff075fe2cd88072ac8434c63a5e4776a2b2a06c))
* **onboarding:** clarify first-run screen with new vs. v1 paths ([#376](https://github.com/team-reflect/reflect-open/issues/376)) ([d105542](https://github.com/team-reflect/reflect-open/commit/d105542d72e30cfe0b5847ea14a16ff212fbb5f0))
* one-click agent-skill install under Settings → Agents ([#523](https://github.com/team-reflect/reflect-open/issues/523)) ([c1b2685](https://github.com/team-reflect/reflect-open/commit/c1b26857cab6878bcbbc24fd49b57822a1a84664))
* pre-fill person notes from Apple Contacts when adding a meeting ([#468](https://github.com/team-reflect/reflect-open/issues/468)) ([6a7474d](https://github.com/team-reflect/reflect-open/commit/6a7474d1c20f4da5f33ef158cb96d42e21b5722f))
* reflect:// deep links — navigation, capture writes, copy deep link ([#455](https://github.com/team-reflect/reflect-open/issues/455)) ([f4f8b02](https://github.com/team-reflect/reflect-open/commit/f4f8b023d33a91e5401ea2bf29e56b9051f20381))
* render incoming backlink snippets as rich text ([#332](https://github.com/team-reflect/reflect-open/issues/332)) ([9a3a962](https://github.com/team-reflect/reflect-open/commit/9a3a962d68824ddb794b8b3628a9810c0bb0ed08))
* resolve meeting attendees by invite email ([#526](https://github.com/team-reflect/reflect-open/issues/526)) ([51542b5](https://github.com/team-reflect/reflect-open/commit/51542b59aad2c8ddc545a2bd72f9518969993594))
* route in-note reflect:// links through the in-app deep-link pipeline ([#473](https://github.com/team-reflect/reflect-open/issues/473)) ([a4e09de](https://github.com/team-reflect/reflect-open/commit/a4e09deea4e9fab2656688b832d2261aa8c8c460))
* **settings:** default editor text size to Small ([#371](https://github.com/team-reflect/reflect-open/issues/371)) ([36e97df](https://github.com/team-reflect/reflect-open/commit/36e97df438356ec0812a9674d0b7d506601deb43))
* show task toolbar counts as badges ([#436](https://github.com/team-reflect/reflect-open/issues/436)) ([e569251](https://github.com/team-reflect/reflect-open/commit/e56925136dbd28d37121b1f0f221b189fbf3bed1))
* trigger a release ([#705](https://github.com/team-reflect/reflect-open/issues/705)) ([955d9cc](https://github.com/team-reflect/reflect-open/commit/955d9ccf104e719952ff870465bf66d2f6e75ed6))
* update meowdown to 0.12.0 with image lightbox and link opening ([#270](https://github.com/team-reflect/reflect-open/issues/270)) ([cbe085d](https://github.com/team-reflect/reflect-open/commit/cbe085d77bd44daeac6f8a81858d9ceb68f14434))
* update meowdown to 0.13.0 ([#271](https://github.com/team-reflect/reflect-open/issues/271)) ([d201c60](https://github.com/team-reflect/reflect-open/commit/d201c6088ad304ef7de987459bef2cd5aa2dab0f))
* update meowdown to 0.14.0 ([#273](https://github.com/team-reflect/reflect-open/issues/273)) ([db7a773](https://github.com/team-reflect/reflect-open/commit/db7a773fb0b4f06729475ef5917254c73b7ffd2a))
* V1-parity filter badges and list polish for the mobile All tab ([#476](https://github.com/team-reflect/reflect-open/issues/476)) ([1ec2212](https://github.com/team-reflect/reflect-open/commit/1ec22122dde4916c9ea741016bbad90f8b53e3df))
* webview-drawn mobile formatting toolbar (Plan 19 decision 8) ([#507](https://github.com/team-reflect/reflect-open/issues/507)) ([5fa6c1c](https://github.com/team-reflect/reflect-open/commit/5fa6c1cbc91c08473dbaa78e10a6203cf0d02f2d))


### Bug Fixes

* add mobile editor gutter ([#492](https://github.com/team-reflect/reflect-open/issues/492)) ([0e77c75](https://github.com/team-reflect/reflect-open/commit/0e77c75da88d2e2db2e261b59f0c9536e3d3a520))
* add mobile tasks floating add button ([#540](https://github.com/team-reflect/reflect-open/issues/540)) ([e56fc27](https://github.com/team-reflect/reflect-open/commit/e56fc27ba60d9895461afa0a83f263c3c6408784))
* align all notes subject column ([#240](https://github.com/team-reflect/reflect-open/issues/240)) ([6159e6d](https://github.com/team-reflect/reflect-open/commit/6159e6de55bb1f580a71f5370fcdc7e0c1542948))
* align task source note links ([#725](https://github.com/team-reflect/reflect-open/issues/725)) ([6a4b324](https://github.com/team-reflect/reflect-open/commit/6a4b324f5844a6409541b1085969e27146e33804))
* allow mobile conflict resolution ([#513](https://github.com/team-reflect/reflect-open/issues/513)) ([ea8823f](https://github.com/team-reflect/reflect-open/commit/ea8823fa75dd479e719c40f0cb96a189789dda2c))
* bulk toggle selected task checkboxes ([#353](https://github.com/team-reflect/reflect-open/issues/353)) ([98e4671](https://github.com/team-reflect/reflect-open/commit/98e46714526462450b075cb8508f0d28f78bc59c))
* **chat:** align search prompt with semantic setting ([#247](https://github.com/team-reflect/reflect-open/issues/247)) ([fa2b03b](https://github.com/team-reflect/reflect-open/commit/fa2b03bc6c59f5447491305dbad8dfca32c6a991))
* **chat:** never dead-end a turn; batch reads and tighten retrieval ([#238](https://github.com/team-reflect/reflect-open/issues/238)) ([387c0d7](https://github.com/team-reflect/reflect-open/commit/387c0d7cadce53a4e77d404425cec223cbcb3bc5))
* **chat:** polish new chat button and selection ([#246](https://github.com/team-reflect/reflect-open/issues/246)) ([d06176b](https://github.com/team-reflect/reflect-open/commit/d06176be043f6828b716b99d1f6ab53da5bfd7b0))
* **chooser:** drop cached iCloud listing after graph delete ([#531](https://github.com/team-reflect/reflect-open/issues/531)) ([7e19c8e](https://github.com/team-reflect/reflect-open/commit/7e19c8ec5ba8f79a9228cb49fc264d91d47962b8))
* clarify iOS onboarding storage choices ([#535](https://github.com/team-reflect/reflect-open/issues/535)) ([993cafd](https://github.com/team-reflect/reflect-open/commit/993cafdcf0395781add83f097e34ab16bc918791))
* clarify private note tooltip ([#204](https://github.com/team-reflect/reflect-open/issues/204)) ([93192d2](https://github.com/team-reflect/reflect-open/commit/93192d23f1a25aaa74f8d68775b8b838268b2dff))
* clear non-max-lines check warnings ([#502](https://github.com/team-reflect/reflect-open/issues/502)) ([2a05b41](https://github.com/team-reflect/reflect-open/commit/2a05b41ea0e4f1c9ee149e0cc5f867ae41735011))
* contain expanded lightbox images ([#327](https://github.com/team-reflect/reflect-open/issues/327)) ([d5f48df](https://github.com/team-reflect/reflect-open/commit/d5f48df018feac9501fd25c6c4409974429de298))
* correct cascade layer order ([#451](https://github.com/team-reflect/reflect-open/issues/451)) ([9c008bf](https://github.com/team-reflect/reflect-open/commit/9c008bfc4a6e669fd7d973533cd487d80b874d7c))
* **daily-note:** standardize appended sections under H2 with a real heading scale ([#378](https://github.com/team-reflect/reflect-open/issues/378)) ([b54e72d](https://github.com/team-reflect/reflect-open/commit/b54e72d6f6d43bd7e9f121c0d23e741a70b09f94))
* default TestFlight builds to timestamp numbers ([#545](https://github.com/team-reflect/reflect-open/issues/545)) ([fe3dd64](https://github.com/team-reflect/reflect-open/commit/fe3dd64a3b830dff7a5372aa760d3e46c145acab))
* **desktop:** add pinned note hover state ([#506](https://github.com/team-reflect/reflect-open/issues/506)) ([3aa168e](https://github.com/team-reflect/reflect-open/commit/3aa168eb3263458c83e9a70c3c2ccabe0d5cc528))
* **desktop:** align note subject sizing ([#277](https://github.com/team-reflect/reflect-open/issues/277)) ([b6cc2e2](https://github.com/team-reflect/reflect-open/commit/b6cc2e2a30bd4c2b196688fbd81ea1162b99525e))
* **desktop:** allow Twitter and YouTube embeds in CSP frame-src ([#284](https://github.com/team-reflect/reflect-open/issues/284)) ([6748ddd](https://github.com/team-reflect/reflect-open/commit/6748dddc80e7e6ae8a136b4e3e541d2437850653))
* **desktop:** always scroll Daily notes to today ([#726](https://github.com/team-reflect/reflect-open/issues/726)) ([b1ad9ec](https://github.com/team-reflect/reflect-open/commit/b1ad9ecdbaa23e0402695d78c70de90ce535317b))
* **desktop:** honor the `timeFormat` setting in the `/now` slash command ([#577](https://github.com/team-reflect/reflect-open/issues/577)) ([b86f692](https://github.com/team-reflect/reflect-open/commit/b86f6925a28d6d4eb19840d476cbd4ea99692cb7))
* **desktop:** keep "All notes" selected while editing a named note ([#365](https://github.com/team-reflect/reflect-open/issues/365)) ([6aa2f6c](https://github.com/team-reflect/reflect-open/commit/6aa2f6cdf94d665b1aa947a554ba1d784747f8d1))
* **desktop:** keep deep link copy keyboard-only ([#508](https://github.com/team-reflect/reflect-open/issues/508)) ([f3b881f](https://github.com/team-reflect/reflect-open/commit/f3b881ff3733754813945337a4bae51aced8ce8d))
* **desktop:** lift task toolbar above drag region ([#242](https://github.com/team-reflect/reflect-open/issues/242)) ([5afcece](https://github.com/team-reflect/reflect-open/commit/5afcece0a8abe8fbd3e315ee00752a0621036181))
* **desktop:** lift task toolbar above drag region ([#244](https://github.com/team-reflect/reflect-open/issues/244)) ([ecfdc9a](https://github.com/team-reflect/reflect-open/commit/ecfdc9a1f51967d2fcdabbab2dd556aeec0e79dd))
* **desktop:** match note title body size ([#267](https://github.com/team-reflect/reflect-open/issues/267)) ([4f92fe5](https://github.com/team-reflect/reflect-open/commit/4f92fe5fc2ea44add57608496d22b3af2f13bfeb))
* **desktop:** open autocomplete menus from toolbar trigger buttons ([#509](https://github.com/team-reflect/reflect-open/issues/509)) ([be37a2c](https://github.com/team-reflect/reflect-open/commit/be37a2c88316c4f3a126b9420f50cf2231c32515))
* **desktop:** open custom app URI scheme links from notes ([#600](https://github.com/team-reflect/reflect-open/issues/600)) ([a2fe0f7](https://github.com/team-reflect/reflect-open/commit/a2fe0f77795d6e646c1bc5150f7199702cd38f52))
* **desktop:** prevent transparent table menu background color ([#326](https://github.com/team-reflect/reflect-open/issues/326)) ([2809c8d](https://github.com/team-reflect/reflect-open/commit/2809c8d3946f7a99a060b76419b5441ed0bde442))
* **desktop:** recover invisible main window ([#716](https://github.com/team-reflect/reflect-open/issues/716)) ([96f11fb](https://github.com/team-reflect/reflect-open/commit/96f11fbbd4ab5cf966bd0fe338922c6b1bd6d94f))
* **desktop:** remove phantom blank line under wrapped wikilink chips on iOS ([#606](https://github.com/team-reflect/reflect-open/issues/606)) ([323b194](https://github.com/team-reflect/reflect-open/commit/323b194f71feabbff213ee75b79d9208906f0cf3))
* **desktop:** return graph switcher to chooser ([#512](https://github.com/team-reflect/reflect-open/issues/512)) ([9c777ca](https://github.com/team-reflect/reflect-open/commit/9c777cafca1c1848625b65d68d1fbc99ba0e6f5e))
* **desktop:** smooth daily stream scroll ([#323](https://github.com/team-reflect/reflect-open/issues/323)) ([b807f16](https://github.com/team-reflect/reflect-open/commit/b807f16bb52642df1c28f28a0950e5adb304c51f))
* **desktop:** stop checkbox text shifting on bullet conversion ([#402](https://github.com/team-reflect/reflect-open/issues/402)) ([dacc369](https://github.com/team-reflect/reflect-open/commit/dacc3693465bc3d55b786ab5f511524b9076d01d))
* **desktop:** stop the window-state jump on launch ([#239](https://github.com/team-reflect/reflect-open/issues/239)) ([20269a4](https://github.com/team-reflect/reflect-open/commit/20269a44265b1449e7eedd5b4b4156b0f747c6fe))
* **desktop:** trash notes via NSFileManager to avoid Finder error ([#334](https://github.com/team-reflect/reflect-open/issues/334)) ([61abc14](https://github.com/team-reflect/reflect-open/commit/61abc1471473e5d369d12b993a054141d6b8a0c3))
* **dev:** implement mobile_storage_local in the browser dev bridge ([#538](https://github.com/team-reflect/reflect-open/issues/538)) ([ed3804a](https://github.com/team-reflect/reflect-open/commit/ed3804a6f6fb63e9eea2d6408f35ad3ddf1255bd))
* **editor:** cap editor heading size at --text-xl ([#237](https://github.com/team-reflect/reflect-open/issues/237)) ([f4f38f3](https://github.com/team-reflect/reflect-open/commit/f4f38f3517f379b9aea7f465b98b4e4a34c965ee))
* **editor:** match note title size to the daily subject ([#290](https://github.com/team-reflect/reflect-open/issues/290)) ([0feab8e](https://github.com/team-reflect/reflect-open/commit/0feab8e50a0781798d66355dfbc80faff1986e3d))
* **editor:** scope meowdown theme tokens to root so popups inherit them ([#299](https://github.com/team-reflect/reflect-open/issues/299)) ([b3a95bd](https://github.com/team-reflect/reflect-open/commit/b3a95bde0519f315e943756d367bad3bed7c68ab))
* **editor:** widen spacing between task checkbox and label ([#373](https://github.com/team-reflect/reflect-open/issues/373)) ([00cfdac](https://github.com/team-reflect/reflect-open/commit/00cfdac360971a5f6df5af3cc44c5129f8e8968f))
* enable desktop updater support ([#343](https://github.com/team-reflect/reflect-open/issues/343)) ([cf173a7](https://github.com/team-reflect/reflect-open/commit/cf173a7b4c81cbd033fec77da24ee3f71856ddee))
* find non-Latin title substrings in search ([#718](https://github.com/team-reflect/reflect-open/issues/718)) ([3e5ce4b](https://github.com/team-reflect/reflect-open/commit/3e5ce4b01cf09d0f6b496dc530295e526193daf9))
* hide the editor block handle on iOS ([#677](https://github.com/team-reflect/reflect-open/issues/677)) ([41df38a](https://github.com/team-reflect/reflect-open/commit/41df38a2cd51db25228c7bc6f49bd09d083036fb))
* **icons:** recolor Reflect Beta icon from near-red to purple-violet ([#370](https://github.com/team-reflect/reflect-open/issues/370)) ([a94f6a6](https://github.com/team-reflect/reflect-open/commit/a94f6a68a348f79da3e28b277ae53dfe656a7ca4))
* **ios:** align mobile screen headers ([#543](https://github.com/team-reflect/reflect-open/issues/543)) ([cf9f807](https://github.com/team-reflect/reflect-open/commit/cf9f807a1385960672d2712686bf017b356642e6))
* **ios:** keep image lightbox opener within safe area ([#541](https://github.com/team-reflect/reflect-open/issues/541)) ([2549fdf](https://github.com/team-reflect/reflect-open/commit/2549fdf805c7f39b132df9cab68037f11c15a9d6))
* **ios:** keep the double-tap caret visible through the keyboard raise ([#567](https://github.com/team-reflect/reflect-open/issues/567)) ([c4d8d16](https://github.com/team-reflect/reflect-open/commit/c4d8d1630e0a9f953bb96e622d7df19a42ef1ded))
* **ios:** keep the hide-keyboard button visible in the formatting toolbar ([#544](https://github.com/team-reflect/reflect-open/issues/544)) ([6f3197f](https://github.com/team-reflect/reflect-open/commit/6f3197f2848cd317456a3068a396922363b4193f))
* **ios:** preserve the ShareExtension App Group entitlement in CI TestFlight builds ([#612](https://github.com/team-reflect/reflect-open/issues/612)) ([d1b124a](https://github.com/team-reflect/reflect-open/commit/d1b124aeacb13fae890dbdafdd2866900b54ecc7))
* keep shortcuts dialog readable ([#470](https://github.com/team-reflect/reflect-open/issues/470)) ([ac6503e](https://github.com/team-reflect/reflect-open/commit/ac6503e818506f07c6ef0a1c00cea26b3fe77e7e))
* keep today shortcut anchored after midnight ([#422](https://github.com/team-reflect/reflect-open/issues/422)) ([ae3787d](https://github.com/team-reflect/reflect-open/commit/ae3787d4a86642d7e551c01b4ae402a1ef04dd50))
* link chat citations and tags ([#188](https://github.com/team-reflect/reflect-open/issues/188)) ([f38a321](https://github.com/team-reflect/reflect-open/commit/f38a321ae470e89680c4da9fb4e858dee14fc4ce))
* link conflict warnings to affected notes ([#714](https://github.com/team-reflect/reflect-open/issues/714)) ([603b6dc](https://github.com/team-reflect/reflect-open/commit/603b6dcd4c38e617632c84a42b15434d5cd00e7d))
* **macos:** restore system window-management shortcuts by assigning NSApp menu roles after install ([#595](https://github.com/team-reflect/reflect-open/issues/595)) ([6637a84](https://github.com/team-reflect/reflect-open/commit/6637a84a6a44ffe49053978cde11216912e2ceee))
* make chat note references clickable ([#245](https://github.com/team-reflect/reflect-open/issues/245)) ([582c82b](https://github.com/team-reflect/reflect-open/commit/582c82bbc8366bca8c308a235f7be78e85c07093))
* mark prereleases as not latest ([#243](https://github.com/team-reflect/reflect-open/issues/243)) ([2e18ffc](https://github.com/team-reflect/reflect-open/commit/2e18ffc95250401eec26fdc137b0b4b7047a9b41))
* match v1 task row focus styling ([#314](https://github.com/team-reflect/reflect-open/issues/314)) ([f1beb33](https://github.com/team-reflect/reflect-open/commit/f1beb3343709e37b1939c922e1d39e0a2ed3cad9))
* **mobile:** align task checkboxes ([#584](https://github.com/team-reflect/reflect-open/issues/584)) ([d83d947](https://github.com/team-reflect/reflect-open/commit/d83d94769c6686abe0637ea48626756f437cc47c))
* **mobile:** dismiss the keyboard on return in the Tasks search too ([#636](https://github.com/team-reflect/reflect-open/issues/636)) ([bf389a8](https://github.com/team-reflect/reflect-open/commit/bf389a8ec17fe6947d270ea9f52705abaed393a8))
* **mobile:** don't focus the editor when navigating between notes ([#575](https://github.com/team-reflect/reflect-open/issues/575)) ([189f38a](https://github.com/team-reflect/reflect-open/commit/189f38a47377ddf1afac0adb0cb71f65c5520a05))
* **mobile:** keep the daily double-tap's end-of-note caret in view ([#611](https://github.com/team-reflect/reflect-open/issues/611)) ([1df5183](https://github.com/team-reflect/reflect-open/commit/1df51830b5dd512f7d43cd3547cd4c4426d536ce))
* **mobile:** keep Today taps on the current day ([#720](https://github.com/team-reflect/reflect-open/issues/720)) ([db82a6b](https://github.com/team-reflect/reflect-open/commit/db82a6bd304ba11802b8f0d7a9334c1917b20a6c))
* **mobile:** let the day-swipe snap animation finish before reporting ([#576](https://github.com/team-reflect/reflect-open/issues/576)) ([d6a3231](https://github.com/team-reflect/reflect-open/commit/d6a323173bb1ee233cb743b67da230385b811997))
* **mobile:** mount the swipe target's neighbor while the day snap animates ([#586](https://github.com/team-reflect/reflect-open/issues/586)) ([35cbe88](https://github.com/team-reflect/reflect-open/commit/35cbe88564d9c0655e978205c222cc1753d4e4c8))
* **mobile:** refine month title roll animation ([#588](https://github.com/team-reflect/reflect-open/issues/588)) ([f29f59c](https://github.com/team-reflect/reflect-open/commit/f29f59cf902b3f9eae0903df4ae2dd38a7895e65))
* **mobile:** slow the month-title roll to a full-height ticker ([#604](https://github.com/team-reflect/reflect-open/issues/604)) ([908cda9](https://github.com/team-reflect/reflect-open/commit/908cda9b38600707246f4cabd13a58cdbd731c84))
* move all notes trash action before filters ([#291](https://github.com/team-reflect/reflect-open/issues/291)) ([11520fb](https://github.com/team-reflect/reflect-open/commit/11520fbaf0592306f52efb36ba025d3898b85c29))
* open lightbox images on ios ([#556](https://github.com/team-reflect/reflect-open/issues/556)) ([fd39890](https://github.com/team-reflect/reflect-open/commit/fd398901b68086acc0da707a5f4ca09b9baf8f78))
* pin the iOS webview scroll offset so keyboard focus can't push the app off-screen ([#496](https://github.com/team-reflect/reflect-open/issues/496)) ([7743c53](https://github.com/team-reflect/reflect-open/commit/7743c53952628eac670dae064400a6c1cbeec764))
* reduce published url font size ([#186](https://github.com/team-reflect/reflect-open/issues/186)) ([63fc70c](https://github.com/team-reflect/reflect-open/commit/63fc70cb7b52cfdcacd0aeee5eefe029b1a8146b))
* **release:** bypass brittle Tauri DMG bundling ([#389](https://github.com/team-reflect/reflect-open/issues/389)) ([8e89180](https://github.com/team-reflect/reflect-open/commit/8e891806d08ca17d21902f2585dabc1ac4cce174))
* **release:** drop stale "set updater feed" plan line ([#380](https://github.com/team-reflect/reflect-open/issues/380)) ([d3057de](https://github.com/team-reflect/reflect-open/commit/d3057de745f01ffa74f5d0ff928155a682ca1cd1))
* **release:** keep macOS sidecars launchable ([#533](https://github.com/team-reflect/reflect-open/issues/533)) ([8ea6ca8](https://github.com/team-reflect/reflect-open/commit/8ea6ca8cfee81e9f1cc490b620a7de43de61f65f))
* **release:** sign DMG with CI certificate keychain ([df139cf](https://github.com/team-reflect/reflect-open/commit/df139cf7909307274ad7f9136f721e895988f4ca))
* remove button hover motion ([#549](https://github.com/team-reflect/reflect-open/issues/549)) ([06715ef](https://github.com/team-reflect/reflect-open/commit/06715efaff75443f4d77d5669b0008c16dd44de9))
* remove task row shadow ([#316](https://github.com/team-reflect/reflect-open/issues/316)) ([7fefed2](https://github.com/team-reflect/reflect-open/commit/7fefed242f1384504dabc32132d2d6d44668ce4a))
* render dropped file attachments as file pills ([#491](https://github.com/team-reflect/reflect-open/issues/491)) ([ea10496](https://github.com/team-reflect/reflect-open/commit/ea104965bc9d5bc654f25fbc1f7eb7cb2ef48204))
* reveal the caret when the keyboard changes the visible area ([#688](https://github.com/team-reflect/reflect-open/issues/688)) ([156bd26](https://github.com/team-reflect/reflect-open/commit/156bd2601c6d4cba3b2c7d0d5cb30c5654f6b2da))
* scroll focused task into view ([#312](https://github.com/team-reflect/reflect-open/issues/312)) ([34a30f9](https://github.com/team-reflect/reflect-open/commit/34a30f988025e0b3a33816ce7851b273a5407692))
* serve note images off the UI thread via a reflect-asset protocol ([#583](https://github.com/team-reflect/reflect-open/issues/583)) ([87b93b1](https://github.com/team-reflect/reflect-open/commit/87b93b1aef7a966fca56456c7541088e8977d994))
* show github backup settings for icloud graphs ([#558](https://github.com/team-reflect/reflect-open/issues/558)) ([bfb6111](https://github.com/team-reflect/reflect-open/commit/bfb6111dcf300bef6804103e28edbd37a7f0ad38))
* show the installed app version in About ([#715](https://github.com/team-reflect/reflect-open/issues/715)) ([56197be](https://github.com/team-reflect/reflect-open/commit/56197be9af13b089dec3a8bb0313d2778c740339))
* simplify backlink styles ([#684](https://github.com/team-reflect/reflect-open/issues/684)) ([45714df](https://github.com/team-reflect/reflect-open/commit/45714df0baa96fe44d981674bbc5af63b1c53f91))
* sort incoming backlinks by source recency (V1 parity) ([#522](https://github.com/team-reflect/reflect-open/issues/522)) ([753f93c](https://github.com/team-reflect/reflect-open/commit/753f93c99a3603f5baba5275fe89fcb245550251))
* target mobile link-filter badges by picked path, not title ([#480](https://github.com/team-reflect/reflect-open/issues/480)) ([d386fee](https://github.com/team-reflect/reflect-open/commit/d386fee551aff00b009eacd68531b6ce5f4f6c7c))
* **tasks:** reconcile Task View's struck rows with tasks reopened at the source note ([#527](https://github.com/team-reflect/reflect-open/issues/527)) ([870e80c](https://github.com/team-reflect/reflect-open/commit/870e80c25f871f9f9ae922b3dec06d1e14627ad7))
* tidy similar notes sidebar ([#195](https://github.com/team-reflect/reflect-open/issues/195)) ([6c436a2](https://github.com/team-reflect/reflect-open/commit/6c436a2fcbf86682577e50e7bef09b70912119fe))
* tone down trash note action color ([#203](https://github.com/team-reflect/reflect-open/issues/203)) ([0ab1f70](https://github.com/team-reflect/reflect-open/commit/0ab1f70a3d8bc4ced8ef7b25c64fd9e4c9e2908e))
* trigger the release build from the desktop package outputs ([#698](https://github.com/team-reflect/reflect-open/issues/698)) ([6d64062](https://github.com/team-reflect/reflect-open/commit/6d64062085f8469844519d0edde996b6d7f0e332))
* update iOS onboarding folder copy ([#552](https://github.com/team-reflect/reflect-open/issues/552)) ([fab9567](https://github.com/team-reflect/reflect-open/commit/fab95672c42e51afc31680801b304148bb22428a))
* update meowdown to ^0.42.1 ([#692](https://github.com/team-reflect/reflect-open/issues/692)) ([66fad1c](https://github.com/team-reflect/reflect-open/commit/66fad1c920aea8c2084c1905aba3f2ade9b3ee2d))
* update meowdown to ^0.42.1 ([#700](https://github.com/team-reflect/reflect-open/issues/700)) ([1e8b4c6](https://github.com/team-reflect/reflect-open/commit/1e8b4c6f4e35a9d540a12509bcfc7ae61b11afd6))
* **update:** clear stale Install action while update downloads ([#375](https://github.com/team-reflect/reflect-open/issues/375)) ([1808ced](https://github.com/team-reflect/reflect-open/commit/1808ced4b9cb3176915e71cbafcbea21389bbc03))
* use hide markdown syntax setting ([#317](https://github.com/team-reflect/reflect-open/issues/317)) ([cddb3b3](https://github.com/team-reflect/reflect-open/commit/cddb3b3b4716ad917520a71577afc011f0900176))
* **windows:** seed the note window's first route — no daily-note flash ([#565](https://github.com/team-reflect/reflect-open/issues/565)) ([381bf56](https://github.com/team-reflect/reflect-open/commit/381bf56d682ce16c2482faaa1a43897d4254e2cc))
* wrap forget graph dialog path ([#519](https://github.com/team-reflect/reflect-open/issues/519)) ([0f70efc](https://github.com/team-reflect/reflect-open/commit/0f70efc425452a2c38bcdba6dcdb2f921fe8c143))


### Performance Improvements

* focused performance pass — memoization, DB indexes, startup deferral ([#233](https://github.com/team-reflect/reflect-open/issues/233)) ([ba7105c](https://github.com/team-reflect/reflect-open/commit/ba7105cb3cb1f4b960d431fbbd3d7be956539dc6))
* **index:** stamp echoes with real mtimes and self-heal stored ones ([#555](https://github.com/team-reflect/reflect-open/issues/555)) ([87cfb3d](https://github.com/team-reflect/reflect-open/commit/87cfb3ddc26d8282bf852a269350cedffab260b3))
* **ios:** fix first-launch freeze on large iCloud graphs ([#532](https://github.com/team-reflect/reflect-open/issues/532)) ([a3c239f](https://github.com/team-reflect/reflect-open/commit/a3c239f0013e84ea04ea3398cca781e7eaee7dbf))
* **ios:** overlap the mobile boot chain — warm platform/chunk/storage, dedupe the settings load ([#546](https://github.com/team-reflect/reflect-open/issues/546)) ([13016c0](https://github.com/team-reflect/reflect-open/commit/13016c0c32f88d3d6199d2edc5a22f4f3574676d))
* **ios:** pace the first-sync burst — sequenced downloads, throttled refetches, spaced sweeps ([#539](https://github.com/team-reflect/reflect-open/issues/539)) ([60bd760](https://github.com/team-reflect/reflect-open/commit/60bd760b9f25d2d4ca6feb563261c2a2c573052b))
* memoize hot-path render churn (daily stream, palette, sidebar, calendar) ([#294](https://github.com/team-reflect/reflect-open/issues/294)) ([f76be20](https://github.com/team-reflect/reflect-open/commit/f76be20ea53304a80d6ee03e82cd7f5cf5c345af))
* **mobile:** native reconcile scan + work-gated index-progress pill ([#568](https://github.com/team-reflect/reflect-open/issues/568)) ([8544cb0](https://github.com/team-reflect/reflect-open/commit/8544cb02888a8f59aff32c4af9f0b2e15cd9f5a2))

## [0.5.0-beta.4](https://github.com/team-reflect/reflect-open/compare/v0.5.0-beta.3...v0.5.0-beta.4) (2026-07-10)


### Bug Fixes

* **desktop:** recover invisible main window ([#716](https://github.com/team-reflect/reflect-open/issues/716)) ([96f11fb](https://github.com/team-reflect/reflect-open/commit/96f11fbbd4ab5cf966bd0fe338922c6b1bd6d94f))
* find non-Latin title substrings in search ([#718](https://github.com/team-reflect/reflect-open/issues/718)) ([3e5ce4b](https://github.com/team-reflect/reflect-open/commit/3e5ce4b01cf09d0f6b496dc530295e526193daf9))
* link conflict warnings to affected notes ([#714](https://github.com/team-reflect/reflect-open/issues/714)) ([603b6dc](https://github.com/team-reflect/reflect-open/commit/603b6dcd4c38e617632c84a42b15434d5cd00e7d))
* **mobile:** keep Today taps on the current day ([#720](https://github.com/team-reflect/reflect-open/issues/720)) ([db82a6b](https://github.com/team-reflect/reflect-open/commit/db82a6bd304ba11802b8f0d7a9334c1917b20a6c))
* show the installed app version in About ([#715](https://github.com/team-reflect/reflect-open/issues/715)) ([56197be](https://github.com/team-reflect/reflect-open/commit/56197be9af13b089dec3a8bb0313d2778c740339))

## [0.5.0-beta.3](https://github.com/team-reflect/reflect-open/compare/v0.5.0-beta.2...v0.5.0-beta.3) (2026-07-10)


### Features

* trigger a release ([#705](https://github.com/team-reflect/reflect-open/issues/705)) ([955d9cc](https://github.com/team-reflect/reflect-open/commit/955d9ccf104e719952ff870465bf66d2f6e75ed6))

## [0.5.0-beta.2](https://github.com/team-reflect/reflect-open/compare/v0.5.0-beta.1...v0.5.0-beta.2) (2026-07-10)


### Bug Fixes

* update meowdown to ^0.42.1 ([#700](https://github.com/team-reflect/reflect-open/issues/700)) ([1e8b4c6](https://github.com/team-reflect/reflect-open/commit/1e8b4c6f4e35a9d540a12509bcfc7ae61b11afd6))

## [0.5.0-beta.1](https://github.com/team-reflect/reflect-open/compare/v0.5.0-beta...v0.5.0-beta.1) (2026-07-09)


### Bug Fixes

* trigger the release build from the desktop package outputs ([#698](https://github.com/team-reflect/reflect-open/issues/698)) ([6d64062](https://github.com/team-reflect/reflect-open/commit/6d64062085f8469844519d0edde996b6d7f0e332))

## [0.5.0-beta](https://github.com/team-reflect/reflect-open/compare/v0.4.0...v0.5.0-beta) (2026-07-09)


### Features

* add hybrid option to markdown syntax setting ([#340](https://github.com/team-reflect/reflect-open/issues/340)) ([1c6d1ae](https://github.com/team-reflect/reflect-open/commit/1c6d1ae7d9e1efdf1fc6bc9772c257c2a56f880c))
* add ISO date display option ([#424](https://github.com/team-reflect/reflect-open/issues/424)) ([6fb6de9](https://github.com/team-reflect/reflect-open/commit/6fb6de993888fc70cfc0cd87b6adc7094476a1e8))
* add OpenRouter AI provider ([#472](https://github.com/team-reflect/reflect-open/issues/472)) ([4ae1502](https://github.com/team-reflect/reflect-open/commit/4ae1502fc5ba8576518f0a07e8e95bd1a72f4a2b))
* adopt meowdown layered theme and simplify editor CSS overrides ([#442](https://github.com/team-reflect/reflect-open/issues/442)) ([a71134e](https://github.com/team-reflect/reflect-open/commit/a71134ea824cd1dddeca3fcb559dc3cf6cc41c27))
* AI menu and prompts on the editor selection ([#459](https://github.com/team-reflect/reflect-open/issues/459)) ([c67a650](https://github.com/team-reflect/reflect-open/commit/c67a650cdf8aa1a99c4b1f2df3d3991c6b83bc5d))
* Apple Calendar integration — events beside the daily note ([#454](https://github.com/team-reflect/reflect-open/issues/454)) ([cdd9a96](https://github.com/team-reflect/reflect-open/commit/cdd9a9671c57fdab12d0c37dc0bbabe2fb5e7c45))
* Apple Contacts integration ([#456](https://github.com/team-reflect/reflect-open/issues/456)) ([10a9f28](https://github.com/team-reflect/reflect-open/commit/10a9f287fe87114495f0d4cfcb1444cfcbb08fb4))
* **assets:** AI description files for images and PDFs (Plan 20) ([#257](https://github.com/team-reflect/reflect-open/issues/257)) ([148d54e](https://github.com/team-reflect/reflect-open/commit/148d54e7208503d1e221091baa1e8421a6966738))
* attendee autocomplete in the add-meeting dialog; Events below Note actions ([#489](https://github.com/team-reflect/reflect-open/issues/489)) ([b6145f4](https://github.com/team-reflect/reflect-open/commit/b6145f48fa72bf584d246878377e6bf9541b6197))
* **backlinks:** toggle task checkboxes in snippets through to the source note ([#608](https://github.com/team-reflect/reflect-open/issues/608)) ([0af0e9e](https://github.com/team-reflect/reflect-open/commit/0af0e9efd2be328a6cfd33109687c3a84a952fd7))
* **backup:** make "grant repo access" a first-class connect step ([#367](https://github.com/team-reflect/reflect-open/issues/367)) ([82230e7](https://github.com/team-reflect/reflect-open/commit/82230e70ae0cb415092329e82b972f0f556c4233))
* **chat:** let AI chat read asset descriptions via read_assets ([#630](https://github.com/team-reflect/reflect-open/issues/630)) ([88ba753](https://github.com/team-reflect/reflect-open/commit/88ba7534b948aa0107aad12c9f5086209e114d06))
* delete a graph to the trash from settings ([#524](https://github.com/team-reflect/reflect-open/issues/524)) ([2a373ec](https://github.com/team-reflect/reflect-open/commit/2a373ec8bf909438099f277e418da97601f5adad))
* **desktop:** ⌘-click a note link opens it in a new window ([#560](https://github.com/team-reflect/reflect-open/issues/560)) ([aa316a7](https://github.com/team-reflect/reflect-open/commit/aa316a76b27c5ca1749f4f6a7be12a45280e1bc3))
* **desktop:** color-coded conflict view with matching resolve buttons ([#601](https://github.com/team-reflect/reflect-open/issues/601)) ([2e457a2](https://github.com/team-reflect/reflect-open/commit/2e457a2009425e3a70496a41776182040b9893ca))
* **desktop:** download Firebase attachments during Reflect V1 import ([#602](https://github.com/team-reflect/reflect-open/issues/602)) ([6de1209](https://github.com/team-reflect/reflect-open/commit/6de120923d30ef70c11d013da876619fa614caa2))
* **desktop:** import Reflect V1 exports from settings ([#516](https://github.com/team-reflect/reflect-open/issues/516)) ([7e3a3ad](https://github.com/team-reflect/reflect-open/commit/7e3a3ad0324b56cbdf0aee68f82d675711d77a24))
* **desktop:** make Daily capture arrivals append at today's end ([#597](https://github.com/team-reflect/reflect-open/issues/597)) ([d6e887e](https://github.com/team-reflect/reflect-open/commit/d6e887e18fe2080834de1697c237855c56512a8a))
* **desktop:** open All Notes filtered by tag on `#tag` click ([#355](https://github.com/team-reflect/reflect-open/issues/355)) ([ab9870f](https://github.com/team-reflect/reflect-open/commit/ab9870f66323769af18d50092213431d6257bd57))
* **desktop:** polish the graph chooser and mobile onboarding UX ([#525](https://github.com/team-reflect/reflect-open/issues/525)) ([c396ac7](https://github.com/team-reflect/reflect-open/commit/c396ac7237369f04d5e887c885db3db2eed0dc5e))
* **desktop:** press ArrowUp/ArrowDown to cross the editor boundary ([#397](https://github.com/team-reflect/reflect-open/issues/397)) ([d1b9c85](https://github.com/team-reflect/reflect-open/commit/d1b9c8544c78bd3b0c4d0aaeb57315585998c1b2))
* **editor:** enable meowdown block handle in notes ([#296](https://github.com/team-reflect/reflect-open/issues/296)) ([c70512f](https://github.com/team-reflect/reflect-open/commit/c70512fb360bb070d5f7f0aa17cdd871b896b19e))
* enforce the notes kind/daily_date invariant at the schema level ([#467](https://github.com/team-reflect/reflect-open/issues/467)) ([ab50744](https://github.com/team-reflect/reflect-open/commit/ab5074418de55081d4a8e46bb68e9ed29195dc75))
* file attachments — paste/drop/attach arbitrary files into notes ([#457](https://github.com/team-reflect/reflect-open/issues/457)) ([39511e6](https://github.com/team-reflect/reflect-open/commit/39511e6bafb9a5362bda8b5921b5122553f69a74))
* iCloud Drive sync — foundations, conflict resolution, and app wiring (Plan 21, Phases 0–4) ([#501](https://github.com/team-reflect/reflect-open/issues/501)) ([546b30b](https://github.com/team-reflect/reflect-open/commit/546b30bfaeed81dcfa923840566e1b56115c6aad))
* incoming-backlinks section on mobile note surfaces ([#482](https://github.com/team-reflect/reflect-open/issues/482)) ([5a2526e](https://github.com/team-reflect/reflect-open/commit/5a2526e4a295322dc6eccb63ab3f1f36166bcebf))
* integrate shadcn chat components ([#420](https://github.com/team-reflect/reflect-open/issues/420)) ([ab10e2c](https://github.com/team-reflect/reflect-open/commit/ab10e2c3bbef7b1350f92953c10bdf3f455cac61))
* **ios:** connect GitHub sync for the local graph ([#559](https://github.com/team-reflect/reflect-open/issues/559)) ([e07b23e](https://github.com/team-reflect/reflect-open/commit/e07b23e5e8e285b7a87a23191e52942a02d2a34b))
* **ios:** dedicated settings screen and iOS-style graph switcher ([#536](https://github.com/team-reflect/reflect-open/issues/536)) ([1ab482c](https://github.com/team-reflect/reflect-open/commit/1ab482cf0de2eb032675e9500b64a043aadd87dc))
* **ios:** land the daily double-tap caret at the end of today's note ([#557](https://github.com/team-reflect/reflect-open/issues/557)) ([23e1f97](https://github.com/team-reflect/reflect-open/commit/23e1f975d2a64df8f5f21ca4d5d9ce2f21c13c63))
* **ios:** markdown editor + add-flow autofocus in the task quick-edit sheet ([#547](https://github.com/team-reflect/reflect-open/issues/547)) ([355c7cc](https://github.com/team-reflect/reflect-open/commit/355c7ccca1e1787be0b81c2f69c86ba9cd7c9071))
* **ios:** save links from the share sheet (App Group capture inbox) ([#520](https://github.com/team-reflect/reflect-open/issues/520)) ([2996d6c](https://github.com/team-reflect/reflect-open/commit/2996d6c2b0086e40a46652f7ef41eb151c2f62d3))
* keep local Git history for graphs without a backup remote ([#610](https://github.com/team-reflect/reflect-open/issues/610)) ([19cfa73](https://github.com/team-reflect/reflect-open/commit/19cfa73eca7fa01b9cc954299db35d527aeb14c4))
* let ios create iCloud graphs ([#514](https://github.com/team-reflect/reflect-open/issues/514)) ([f282ab9](https://github.com/team-reflect/reflect-open/commit/f282ab9b0894be5717aad43264130be9043e7198))
* light impact haptics for mobile date and tab taps ([#479](https://github.com/team-reflect/reflect-open/issues/479)) ([abb83ff](https://github.com/team-reflect/reflect-open/commit/abb83ff08e8bb12b07a571df6912581f46a07ce6))
* mobile editor input hygiene, focus contract, and touch affordances ([#477](https://github.com/team-reflect/reflect-open/issues/477)) ([d2dd15c](https://github.com/team-reflect/reflect-open/commit/d2dd15cc0e3e251cfd66a3b93ff2f3b118c5f766))
* mobile sync slice — foreground cycles, background flush, live status (Plan 19 step 10) ([#483](https://github.com/team-reflect/reflect-open/issues/483)) ([b5e3969](https://github.com/team-reflect/reflect-open/commit/b5e3969c6803120ad070d7e16f574f68a23df436))
* **mobile:** All-tab double-tap focuses search, search key dismisses keyboard ([#627](https://github.com/team-reflect/reflect-open/issues/627)) ([51bf802](https://github.com/team-reflect/reflect-open/commit/51bf80255d0f88c34bd1d911826829d9a9143517))
* **mobile:** month picker sheet and rolling month title on the daily strip ([#585](https://github.com/team-reflect/reflect-open/issues/585)) ([e654c67](https://github.com/team-reflect/reflect-open/commit/e654c675d6138eb866f4c20b947b18c69271b149))
* **mobile:** port the AI chat to iOS as a Chat tab (Plan 23) ([#564](https://github.com/team-reflect/reflect-open/issues/564)) ([c2dee0a](https://github.com/team-reflect/reflect-open/commit/c2dee0a74810d537ad207bab1c3f3cab218a6817))
* **mobile:** slide the calendar strip's selection circle between days ([#587](https://github.com/team-reflect/reflect-open/issues/587)) ([07d5bd0](https://github.com/team-reflect/reflect-open/commit/07d5bd075f452341ba4762ef3a89e49256ce26e2))
* **mobile:** Tasks tab — desktop task data with a touch surface ([#518](https://github.com/team-reflect/reflect-open/issues/518)) ([554fecb](https://github.com/team-reflect/reflect-open/commit/554fecb0c70a2c681510ee45a1f8152a11e5fafa))
* native push/pop transitions and edge back-swipe for the mobile shell ([#485](https://github.com/team-reflect/reflect-open/issues/485)) ([ffb8231](https://github.com/team-reflect/reflect-open/commit/ffb8231b34db9ff3aa0b9daac7d7ec04fbb57c4e))
* note templates — templates/ folder, palette insertion, settings management ([#458](https://github.com/team-reflect/reflect-open/issues/458)) ([eff075f](https://github.com/team-reflect/reflect-open/commit/eff075fe2cd88072ac8434c63a5e4776a2b2a06c))
* **onboarding:** clarify first-run screen with new vs. v1 paths ([#376](https://github.com/team-reflect/reflect-open/issues/376)) ([d105542](https://github.com/team-reflect/reflect-open/commit/d105542d72e30cfe0b5847ea14a16ff212fbb5f0))
* one-click agent-skill install under Settings → Agents ([#523](https://github.com/team-reflect/reflect-open/issues/523)) ([c1b2685](https://github.com/team-reflect/reflect-open/commit/c1b26857cab6878bcbbc24fd49b57822a1a84664))
* pre-fill person notes from Apple Contacts when adding a meeting ([#468](https://github.com/team-reflect/reflect-open/issues/468)) ([6a7474d](https://github.com/team-reflect/reflect-open/commit/6a7474d1c20f4da5f33ef158cb96d42e21b5722f))
* reflect:// deep links — navigation, capture writes, copy deep link ([#455](https://github.com/team-reflect/reflect-open/issues/455)) ([f4f8b02](https://github.com/team-reflect/reflect-open/commit/f4f8b023d33a91e5401ea2bf29e56b9051f20381))
* render incoming backlink snippets as rich text ([#332](https://github.com/team-reflect/reflect-open/issues/332)) ([9a3a962](https://github.com/team-reflect/reflect-open/commit/9a3a962d68824ddb794b8b3628a9810c0bb0ed08))
* resolve meeting attendees by invite email ([#526](https://github.com/team-reflect/reflect-open/issues/526)) ([51542b5](https://github.com/team-reflect/reflect-open/commit/51542b59aad2c8ddc545a2bd72f9518969993594))
* route in-note reflect:// links through the in-app deep-link pipeline ([#473](https://github.com/team-reflect/reflect-open/issues/473)) ([a4e09de](https://github.com/team-reflect/reflect-open/commit/a4e09deea4e9fab2656688b832d2261aa8c8c460))
* **settings:** default editor text size to Small ([#371](https://github.com/team-reflect/reflect-open/issues/371)) ([36e97df](https://github.com/team-reflect/reflect-open/commit/36e97df438356ec0812a9674d0b7d506601deb43))
* show task toolbar counts as badges ([#436](https://github.com/team-reflect/reflect-open/issues/436)) ([e569251](https://github.com/team-reflect/reflect-open/commit/e56925136dbd28d37121b1f0f221b189fbf3bed1))
* update meowdown to 0.12.0 with image lightbox and link opening ([#270](https://github.com/team-reflect/reflect-open/issues/270)) ([cbe085d](https://github.com/team-reflect/reflect-open/commit/cbe085d77bd44daeac6f8a81858d9ceb68f14434))
* update meowdown to 0.13.0 ([#271](https://github.com/team-reflect/reflect-open/issues/271)) ([d201c60](https://github.com/team-reflect/reflect-open/commit/d201c6088ad304ef7de987459bef2cd5aa2dab0f))
* update meowdown to 0.14.0 ([#273](https://github.com/team-reflect/reflect-open/issues/273)) ([db7a773](https://github.com/team-reflect/reflect-open/commit/db7a773fb0b4f06729475ef5917254c73b7ffd2a))
* V1-parity filter badges and list polish for the mobile All tab ([#476](https://github.com/team-reflect/reflect-open/issues/476)) ([1ec2212](https://github.com/team-reflect/reflect-open/commit/1ec22122dde4916c9ea741016bbad90f8b53e3df))
* webview-drawn mobile formatting toolbar (Plan 19 decision 8) ([#507](https://github.com/team-reflect/reflect-open/issues/507)) ([5fa6c1c](https://github.com/team-reflect/reflect-open/commit/5fa6c1cbc91c08473dbaa78e10a6203cf0d02f2d))


### Bug Fixes

* add mobile editor gutter ([#492](https://github.com/team-reflect/reflect-open/issues/492)) ([0e77c75](https://github.com/team-reflect/reflect-open/commit/0e77c75da88d2e2db2e261b59f0c9536e3d3a520))
* add mobile tasks floating add button ([#540](https://github.com/team-reflect/reflect-open/issues/540)) ([e56fc27](https://github.com/team-reflect/reflect-open/commit/e56fc27ba60d9895461afa0a83f263c3c6408784))
* align all notes subject column ([#240](https://github.com/team-reflect/reflect-open/issues/240)) ([6159e6d](https://github.com/team-reflect/reflect-open/commit/6159e6de55bb1f580a71f5370fcdc7e0c1542948))
* allow mobile conflict resolution ([#513](https://github.com/team-reflect/reflect-open/issues/513)) ([ea8823f](https://github.com/team-reflect/reflect-open/commit/ea8823fa75dd479e719c40f0cb96a189789dda2c))
* bulk toggle selected task checkboxes ([#353](https://github.com/team-reflect/reflect-open/issues/353)) ([98e4671](https://github.com/team-reflect/reflect-open/commit/98e46714526462450b075cb8508f0d28f78bc59c))
* **chat:** align search prompt with semantic setting ([#247](https://github.com/team-reflect/reflect-open/issues/247)) ([fa2b03b](https://github.com/team-reflect/reflect-open/commit/fa2b03bc6c59f5447491305dbad8dfca32c6a991))
* **chat:** never dead-end a turn; batch reads and tighten retrieval ([#238](https://github.com/team-reflect/reflect-open/issues/238)) ([387c0d7](https://github.com/team-reflect/reflect-open/commit/387c0d7cadce53a4e77d404425cec223cbcb3bc5))
* **chat:** polish new chat button and selection ([#246](https://github.com/team-reflect/reflect-open/issues/246)) ([d06176b](https://github.com/team-reflect/reflect-open/commit/d06176be043f6828b716b99d1f6ab53da5bfd7b0))
* **chooser:** drop cached iCloud listing after graph delete ([#531](https://github.com/team-reflect/reflect-open/issues/531)) ([7e19c8e](https://github.com/team-reflect/reflect-open/commit/7e19c8ec5ba8f79a9228cb49fc264d91d47962b8))
* clarify iOS onboarding storage choices ([#535](https://github.com/team-reflect/reflect-open/issues/535)) ([993cafd](https://github.com/team-reflect/reflect-open/commit/993cafdcf0395781add83f097e34ab16bc918791))
* clarify private note tooltip ([#204](https://github.com/team-reflect/reflect-open/issues/204)) ([93192d2](https://github.com/team-reflect/reflect-open/commit/93192d23f1a25aaa74f8d68775b8b838268b2dff))
* clear non-max-lines check warnings ([#502](https://github.com/team-reflect/reflect-open/issues/502)) ([2a05b41](https://github.com/team-reflect/reflect-open/commit/2a05b41ea0e4f1c9ee149e0cc5f867ae41735011))
* contain expanded lightbox images ([#327](https://github.com/team-reflect/reflect-open/issues/327)) ([d5f48df](https://github.com/team-reflect/reflect-open/commit/d5f48df018feac9501fd25c6c4409974429de298))
* correct cascade layer order ([#451](https://github.com/team-reflect/reflect-open/issues/451)) ([9c008bf](https://github.com/team-reflect/reflect-open/commit/9c008bfc4a6e669fd7d973533cd487d80b874d7c))
* **daily-note:** standardize appended sections under H2 with a real heading scale ([#378](https://github.com/team-reflect/reflect-open/issues/378)) ([b54e72d](https://github.com/team-reflect/reflect-open/commit/b54e72d6f6d43bd7e9f121c0d23e741a70b09f94))
* default TestFlight builds to timestamp numbers ([#545](https://github.com/team-reflect/reflect-open/issues/545)) ([fe3dd64](https://github.com/team-reflect/reflect-open/commit/fe3dd64a3b830dff7a5372aa760d3e46c145acab))
* **desktop:** add pinned note hover state ([#506](https://github.com/team-reflect/reflect-open/issues/506)) ([3aa168e](https://github.com/team-reflect/reflect-open/commit/3aa168eb3263458c83e9a70c3c2ccabe0d5cc528))
* **desktop:** align note subject sizing ([#277](https://github.com/team-reflect/reflect-open/issues/277)) ([b6cc2e2](https://github.com/team-reflect/reflect-open/commit/b6cc2e2a30bd4c2b196688fbd81ea1162b99525e))
* **desktop:** allow Twitter and YouTube embeds in CSP frame-src ([#284](https://github.com/team-reflect/reflect-open/issues/284)) ([6748ddd](https://github.com/team-reflect/reflect-open/commit/6748dddc80e7e6ae8a136b4e3e541d2437850653))
* **desktop:** honor the `timeFormat` setting in the `/now` slash command ([#577](https://github.com/team-reflect/reflect-open/issues/577)) ([b86f692](https://github.com/team-reflect/reflect-open/commit/b86f6925a28d6d4eb19840d476cbd4ea99692cb7))
* **desktop:** keep "All notes" selected while editing a named note ([#365](https://github.com/team-reflect/reflect-open/issues/365)) ([6aa2f6c](https://github.com/team-reflect/reflect-open/commit/6aa2f6cdf94d665b1aa947a554ba1d784747f8d1))
* **desktop:** keep deep link copy keyboard-only ([#508](https://github.com/team-reflect/reflect-open/issues/508)) ([f3b881f](https://github.com/team-reflect/reflect-open/commit/f3b881ff3733754813945337a4bae51aced8ce8d))
* **desktop:** lift task toolbar above drag region ([#242](https://github.com/team-reflect/reflect-open/issues/242)) ([5afcece](https://github.com/team-reflect/reflect-open/commit/5afcece0a8abe8fbd3e315ee00752a0621036181))
* **desktop:** lift task toolbar above drag region ([#244](https://github.com/team-reflect/reflect-open/issues/244)) ([ecfdc9a](https://github.com/team-reflect/reflect-open/commit/ecfdc9a1f51967d2fcdabbab2dd556aeec0e79dd))
* **desktop:** match note title body size ([#267](https://github.com/team-reflect/reflect-open/issues/267)) ([4f92fe5](https://github.com/team-reflect/reflect-open/commit/4f92fe5fc2ea44add57608496d22b3af2f13bfeb))
* **desktop:** open autocomplete menus from toolbar trigger buttons ([#509](https://github.com/team-reflect/reflect-open/issues/509)) ([be37a2c](https://github.com/team-reflect/reflect-open/commit/be37a2c88316c4f3a126b9420f50cf2231c32515))
* **desktop:** open custom app URI scheme links from notes ([#600](https://github.com/team-reflect/reflect-open/issues/600)) ([a2fe0f7](https://github.com/team-reflect/reflect-open/commit/a2fe0f77795d6e646c1bc5150f7199702cd38f52))
* **desktop:** prevent transparent table menu background color ([#326](https://github.com/team-reflect/reflect-open/issues/326)) ([2809c8d](https://github.com/team-reflect/reflect-open/commit/2809c8d3946f7a99a060b76419b5441ed0bde442))
* **desktop:** remove phantom blank line under wrapped wikilink chips on iOS ([#606](https://github.com/team-reflect/reflect-open/issues/606)) ([323b194](https://github.com/team-reflect/reflect-open/commit/323b194f71feabbff213ee75b79d9208906f0cf3))
* **desktop:** return graph switcher to chooser ([#512](https://github.com/team-reflect/reflect-open/issues/512)) ([9c777ca](https://github.com/team-reflect/reflect-open/commit/9c777cafca1c1848625b65d68d1fbc99ba0e6f5e))
* **desktop:** smooth daily stream scroll ([#323](https://github.com/team-reflect/reflect-open/issues/323)) ([b807f16](https://github.com/team-reflect/reflect-open/commit/b807f16bb52642df1c28f28a0950e5adb304c51f))
* **desktop:** stop checkbox text shifting on bullet conversion ([#402](https://github.com/team-reflect/reflect-open/issues/402)) ([dacc369](https://github.com/team-reflect/reflect-open/commit/dacc3693465bc3d55b786ab5f511524b9076d01d))
* **desktop:** stop the window-state jump on launch ([#239](https://github.com/team-reflect/reflect-open/issues/239)) ([20269a4](https://github.com/team-reflect/reflect-open/commit/20269a44265b1449e7eedd5b4b4156b0f747c6fe))
* **desktop:** trash notes via NSFileManager to avoid Finder error ([#334](https://github.com/team-reflect/reflect-open/issues/334)) ([61abc14](https://github.com/team-reflect/reflect-open/commit/61abc1471473e5d369d12b993a054141d6b8a0c3))
* **dev:** implement mobile_storage_local in the browser dev bridge ([#538](https://github.com/team-reflect/reflect-open/issues/538)) ([ed3804a](https://github.com/team-reflect/reflect-open/commit/ed3804a6f6fb63e9eea2d6408f35ad3ddf1255bd))
* **editor:** cap editor heading size at --text-xl ([#237](https://github.com/team-reflect/reflect-open/issues/237)) ([f4f38f3](https://github.com/team-reflect/reflect-open/commit/f4f38f3517f379b9aea7f465b98b4e4a34c965ee))
* **editor:** match note title size to the daily subject ([#290](https://github.com/team-reflect/reflect-open/issues/290)) ([0feab8e](https://github.com/team-reflect/reflect-open/commit/0feab8e50a0781798d66355dfbc80faff1986e3d))
* **editor:** scope meowdown theme tokens to root so popups inherit them ([#299](https://github.com/team-reflect/reflect-open/issues/299)) ([b3a95bd](https://github.com/team-reflect/reflect-open/commit/b3a95bde0519f315e943756d367bad3bed7c68ab))
* **editor:** widen spacing between task checkbox and label ([#373](https://github.com/team-reflect/reflect-open/issues/373)) ([00cfdac](https://github.com/team-reflect/reflect-open/commit/00cfdac360971a5f6df5af3cc44c5129f8e8968f))
* enable desktop updater support ([#343](https://github.com/team-reflect/reflect-open/issues/343)) ([cf173a7](https://github.com/team-reflect/reflect-open/commit/cf173a7b4c81cbd033fec77da24ee3f71856ddee))
* hide the editor block handle on iOS ([#677](https://github.com/team-reflect/reflect-open/issues/677)) ([41df38a](https://github.com/team-reflect/reflect-open/commit/41df38a2cd51db25228c7bc6f49bd09d083036fb))
* **icons:** recolor Reflect Beta icon from near-red to purple-violet ([#370](https://github.com/team-reflect/reflect-open/issues/370)) ([a94f6a6](https://github.com/team-reflect/reflect-open/commit/a94f6a68a348f79da3e28b277ae53dfe656a7ca4))
* **ios:** align mobile screen headers ([#543](https://github.com/team-reflect/reflect-open/issues/543)) ([cf9f807](https://github.com/team-reflect/reflect-open/commit/cf9f807a1385960672d2712686bf017b356642e6))
* **ios:** keep image lightbox opener within safe area ([#541](https://github.com/team-reflect/reflect-open/issues/541)) ([2549fdf](https://github.com/team-reflect/reflect-open/commit/2549fdf805c7f39b132df9cab68037f11c15a9d6))
* **ios:** keep the double-tap caret visible through the keyboard raise ([#567](https://github.com/team-reflect/reflect-open/issues/567)) ([c4d8d16](https://github.com/team-reflect/reflect-open/commit/c4d8d1630e0a9f953bb96e622d7df19a42ef1ded))
* **ios:** keep the hide-keyboard button visible in the formatting toolbar ([#544](https://github.com/team-reflect/reflect-open/issues/544)) ([6f3197f](https://github.com/team-reflect/reflect-open/commit/6f3197f2848cd317456a3068a396922363b4193f))
* **ios:** preserve the ShareExtension App Group entitlement in CI TestFlight builds ([#612](https://github.com/team-reflect/reflect-open/issues/612)) ([d1b124a](https://github.com/team-reflect/reflect-open/commit/d1b124aeacb13fae890dbdafdd2866900b54ecc7))
* keep shortcuts dialog readable ([#470](https://github.com/team-reflect/reflect-open/issues/470)) ([ac6503e](https://github.com/team-reflect/reflect-open/commit/ac6503e818506f07c6ef0a1c00cea26b3fe77e7e))
* keep today shortcut anchored after midnight ([#422](https://github.com/team-reflect/reflect-open/issues/422)) ([ae3787d](https://github.com/team-reflect/reflect-open/commit/ae3787d4a86642d7e551c01b4ae402a1ef04dd50))
* link chat citations and tags ([#188](https://github.com/team-reflect/reflect-open/issues/188)) ([f38a321](https://github.com/team-reflect/reflect-open/commit/f38a321ae470e89680c4da9fb4e858dee14fc4ce))
* **macos:** restore system window-management shortcuts by assigning NSApp menu roles after install ([#595](https://github.com/team-reflect/reflect-open/issues/595)) ([6637a84](https://github.com/team-reflect/reflect-open/commit/6637a84a6a44ffe49053978cde11216912e2ceee))
* make chat note references clickable ([#245](https://github.com/team-reflect/reflect-open/issues/245)) ([582c82b](https://github.com/team-reflect/reflect-open/commit/582c82bbc8366bca8c308a235f7be78e85c07093))
* mark prereleases as not latest ([#243](https://github.com/team-reflect/reflect-open/issues/243)) ([2e18ffc](https://github.com/team-reflect/reflect-open/commit/2e18ffc95250401eec26fdc137b0b4b7047a9b41))
* match v1 task row focus styling ([#314](https://github.com/team-reflect/reflect-open/issues/314)) ([f1beb33](https://github.com/team-reflect/reflect-open/commit/f1beb3343709e37b1939c922e1d39e0a2ed3cad9))
* merge master into next (resolve Cargo.toml conflicts) ([44518c2](https://github.com/team-reflect/reflect-open/commit/44518c2ff629f87372aae31b08b2ca5243d71862))
* **mobile:** align task checkboxes ([#584](https://github.com/team-reflect/reflect-open/issues/584)) ([d83d947](https://github.com/team-reflect/reflect-open/commit/d83d94769c6686abe0637ea48626756f437cc47c))
* **mobile:** dismiss the keyboard on return in the Tasks search too ([#636](https://github.com/team-reflect/reflect-open/issues/636)) ([bf389a8](https://github.com/team-reflect/reflect-open/commit/bf389a8ec17fe6947d270ea9f52705abaed393a8))
* **mobile:** don't focus the editor when navigating between notes ([#575](https://github.com/team-reflect/reflect-open/issues/575)) ([189f38a](https://github.com/team-reflect/reflect-open/commit/189f38a47377ddf1afac0adb0cb71f65c5520a05))
* **mobile:** keep the daily double-tap's end-of-note caret in view ([#611](https://github.com/team-reflect/reflect-open/issues/611)) ([1df5183](https://github.com/team-reflect/reflect-open/commit/1df51830b5dd512f7d43cd3547cd4c4426d536ce))
* **mobile:** let the day-swipe snap animation finish before reporting ([#576](https://github.com/team-reflect/reflect-open/issues/576)) ([d6a3231](https://github.com/team-reflect/reflect-open/commit/d6a323173bb1ee233cb743b67da230385b811997))
* **mobile:** mount the swipe target's neighbor while the day snap animates ([#586](https://github.com/team-reflect/reflect-open/issues/586)) ([35cbe88](https://github.com/team-reflect/reflect-open/commit/35cbe88564d9c0655e978205c222cc1753d4e4c8))
* **mobile:** refine month title roll animation ([#588](https://github.com/team-reflect/reflect-open/issues/588)) ([f29f59c](https://github.com/team-reflect/reflect-open/commit/f29f59cf902b3f9eae0903df4ae2dd38a7895e65))
* **mobile:** slow the month-title roll to a full-height ticker ([#604](https://github.com/team-reflect/reflect-open/issues/604)) ([908cda9](https://github.com/team-reflect/reflect-open/commit/908cda9b38600707246f4cabd13a58cdbd731c84))
* move all notes trash action before filters ([#291](https://github.com/team-reflect/reflect-open/issues/291)) ([11520fb](https://github.com/team-reflect/reflect-open/commit/11520fbaf0592306f52efb36ba025d3898b85c29))
* open lightbox images on ios ([#556](https://github.com/team-reflect/reflect-open/issues/556)) ([fd39890](https://github.com/team-reflect/reflect-open/commit/fd398901b68086acc0da707a5f4ca09b9baf8f78))
* pin the iOS webview scroll offset so keyboard focus can't push the app off-screen ([#496](https://github.com/team-reflect/reflect-open/issues/496)) ([7743c53](https://github.com/team-reflect/reflect-open/commit/7743c53952628eac670dae064400a6c1cbeec764))
* reduce published url font size ([#186](https://github.com/team-reflect/reflect-open/issues/186)) ([63fc70c](https://github.com/team-reflect/reflect-open/commit/63fc70cb7b52cfdcacd0aeee5eefe029b1a8146b))
* **release:** bypass brittle Tauri DMG bundling ([#389](https://github.com/team-reflect/reflect-open/issues/389)) ([8e89180](https://github.com/team-reflect/reflect-open/commit/8e891806d08ca17d21902f2585dabc1ac4cce174))
* **release:** drop stale "set updater feed" plan line ([#380](https://github.com/team-reflect/reflect-open/issues/380)) ([d3057de](https://github.com/team-reflect/reflect-open/commit/d3057de745f01ffa74f5d0ff928155a682ca1cd1))
* **release:** keep macOS sidecars launchable ([#533](https://github.com/team-reflect/reflect-open/issues/533)) ([8ea6ca8](https://github.com/team-reflect/reflect-open/commit/8ea6ca8cfee81e9f1cc490b620a7de43de61f65f))
* **release:** sign DMG with CI certificate keychain ([df139cf](https://github.com/team-reflect/reflect-open/commit/df139cf7909307274ad7f9136f721e895988f4ca))
* remove button hover motion ([#549](https://github.com/team-reflect/reflect-open/issues/549)) ([06715ef](https://github.com/team-reflect/reflect-open/commit/06715efaff75443f4d77d5669b0008c16dd44de9))
* remove task row shadow ([#316](https://github.com/team-reflect/reflect-open/issues/316)) ([7fefed2](https://github.com/team-reflect/reflect-open/commit/7fefed242f1384504dabc32132d2d6d44668ce4a))
* render dropped file attachments as file pills ([#491](https://github.com/team-reflect/reflect-open/issues/491)) ([ea10496](https://github.com/team-reflect/reflect-open/commit/ea104965bc9d5bc654f25fbc1f7eb7cb2ef48204))
* replace "Mark as public" with "Un-mark as private" in note actions ([#146](https://github.com/team-reflect/reflect-open/issues/146)) ([b52da27](https://github.com/team-reflect/reflect-open/commit/b52da27aa928b9df454f1fff893ddc358db33ee7))
* reveal the caret when the keyboard changes the visible area ([#688](https://github.com/team-reflect/reflect-open/issues/688)) ([156bd26](https://github.com/team-reflect/reflect-open/commit/156bd2601c6d4cba3b2c7d0d5cb30c5654f6b2da))
* scroll focused task into view ([#312](https://github.com/team-reflect/reflect-open/issues/312)) ([34a30f9](https://github.com/team-reflect/reflect-open/commit/34a30f988025e0b3a33816ce7851b273a5407692))
* serve note images off the UI thread via a reflect-asset protocol ([#583](https://github.com/team-reflect/reflect-open/issues/583)) ([87b93b1](https://github.com/team-reflect/reflect-open/commit/87b93b1aef7a966fca56456c7541088e8977d994))
* show github backup settings for icloud graphs ([#558](https://github.com/team-reflect/reflect-open/issues/558)) ([bfb6111](https://github.com/team-reflect/reflect-open/commit/bfb6111dcf300bef6804103e28edbd37a7f0ad38))
* simplify backlink styles ([#684](https://github.com/team-reflect/reflect-open/issues/684)) ([45714df](https://github.com/team-reflect/reflect-open/commit/45714df0baa96fe44d981674bbc5af63b1c53f91))
* sort incoming backlinks by source recency (V1 parity) ([#522](https://github.com/team-reflect/reflect-open/issues/522)) ([753f93c](https://github.com/team-reflect/reflect-open/commit/753f93c99a3603f5baba5275fe89fcb245550251))
* target mobile link-filter badges by picked path, not title ([#480](https://github.com/team-reflect/reflect-open/issues/480)) ([d386fee](https://github.com/team-reflect/reflect-open/commit/d386fee551aff00b009eacd68531b6ce5f4f6c7c))
* **tasks:** reconcile Task View's struck rows with tasks reopened at the source note ([#527](https://github.com/team-reflect/reflect-open/issues/527)) ([870e80c](https://github.com/team-reflect/reflect-open/commit/870e80c25f871f9f9ae922b3dec06d1e14627ad7))
* tidy similar notes sidebar ([#195](https://github.com/team-reflect/reflect-open/issues/195)) ([6c436a2](https://github.com/team-reflect/reflect-open/commit/6c436a2fcbf86682577e50e7bef09b70912119fe))
* tone down trash note action color ([#203](https://github.com/team-reflect/reflect-open/issues/203)) ([0ab1f70](https://github.com/team-reflect/reflect-open/commit/0ab1f70a3d8bc4ced8ef7b25c64fd9e4c9e2908e))
* update iOS onboarding folder copy ([#552](https://github.com/team-reflect/reflect-open/issues/552)) ([fab9567](https://github.com/team-reflect/reflect-open/commit/fab95672c42e51afc31680801b304148bb22428a))
* update meowdown to ^0.42.1 ([#692](https://github.com/team-reflect/reflect-open/issues/692)) ([66fad1c](https://github.com/team-reflect/reflect-open/commit/66fad1c920aea8c2084c1905aba3f2ade9b3ee2d))
* **update:** clear stale Install action while update downloads ([#375](https://github.com/team-reflect/reflect-open/issues/375)) ([1808ced](https://github.com/team-reflect/reflect-open/commit/1808ced4b9cb3176915e71cbafcbea21389bbc03))
* use hide markdown syntax setting ([#317](https://github.com/team-reflect/reflect-open/issues/317)) ([cddb3b3](https://github.com/team-reflect/reflect-open/commit/cddb3b3b4716ad917520a71577afc011f0900176))
* **windows:** seed the note window's first route — no daily-note flash ([#565](https://github.com/team-reflect/reflect-open/issues/565)) ([381bf56](https://github.com/team-reflect/reflect-open/commit/381bf56d682ce16c2482faaa1a43897d4254e2cc))
* wrap forget graph dialog path ([#519](https://github.com/team-reflect/reflect-open/issues/519)) ([0f70efc](https://github.com/team-reflect/reflect-open/commit/0f70efc425452a2c38bcdba6dcdb2f921fe8c143))


### Performance Improvements

* focused performance pass — memoization, DB indexes, startup deferral ([#233](https://github.com/team-reflect/reflect-open/issues/233)) ([ba7105c](https://github.com/team-reflect/reflect-open/commit/ba7105cb3cb1f4b960d431fbbd3d7be956539dc6))
* **index:** stamp echoes with real mtimes and self-heal stored ones ([#555](https://github.com/team-reflect/reflect-open/issues/555)) ([87cfb3d](https://github.com/team-reflect/reflect-open/commit/87cfb3ddc26d8282bf852a269350cedffab260b3))
* **ios:** fix first-launch freeze on large iCloud graphs ([#532](https://github.com/team-reflect/reflect-open/issues/532)) ([a3c239f](https://github.com/team-reflect/reflect-open/commit/a3c239f0013e84ea04ea3398cca781e7eaee7dbf))
* **ios:** overlap the mobile boot chain — warm platform/chunk/storage, dedupe the settings load ([#546](https://github.com/team-reflect/reflect-open/issues/546)) ([13016c0](https://github.com/team-reflect/reflect-open/commit/13016c0c32f88d3d6199d2edc5a22f4f3574676d))
* **ios:** pace the first-sync burst — sequenced downloads, throttled refetches, spaced sweeps ([#539](https://github.com/team-reflect/reflect-open/issues/539)) ([60bd760](https://github.com/team-reflect/reflect-open/commit/60bd760b9f25d2d4ca6feb563261c2a2c573052b))
* memoize hot-path render churn (daily stream, palette, sidebar, calendar) ([#294](https://github.com/team-reflect/reflect-open/issues/294)) ([f76be20](https://github.com/team-reflect/reflect-open/commit/f76be20ea53304a80d6ee03e82cd7f5cf5c345af))
* **mobile:** native reconcile scan + work-gated index-progress pill ([#568](https://github.com/team-reflect/reflect-open/issues/568)) ([8544cb0](https://github.com/team-reflect/reflect-open/commit/8544cb02888a8f59aff32c4af9f0b2e15cd9f5a2))
