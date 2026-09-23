# youtube-relay

A static page, deployed to https://youtube-relay.reflect.app, that the app loads in an iframe to play YouTube videos: `https://youtube-relay.reflect.app/#v=<video id>`.

## Why

YouTube's embedded player requires a `Referer` header and shows "Error 153" without one. On macOS and iOS, the app page is `tauri://localhost`, and WebKit never sends a `Referer` from a page whose scheme is not `http` or `https`. So a YouTube iframe placed directly in the app always fails in production builds (dev builds work because they run on `http://localhost:1420`).

This page has an `https` origin. The app embeds this page, and this page embeds the YouTube player, so YouTube receives `Referer: https://youtube-relay.reflect.app/`. See [YouTube's API Client Identity requirement](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity) and https://github.com/tauri-apps/tauri/issues/14422.

The video id is passed in the URL fragment, so it is never sent to the server. The page only accepts an 11-character YouTube video id.

## Deploy

A Vercel project with Root Directory `apps/youtube-relay` and no build step, deployed manually.
