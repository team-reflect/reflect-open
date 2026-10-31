# tauri-plugin-web-auth

Opens a web page in the system authentication session and returns the
callback URL it redirects to, for OAuth-style sign-in without leaving the app.
On iOS this is `ASWebAuthenticationSession`: the sheet can share Safari's
cookies, and the system intercepts the callback URL itself, so no deep link
is involved. iOS only; the desktop build answers every request as cancelled.
