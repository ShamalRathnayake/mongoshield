---
"mongoshield": minor
---

Add Dropbox storage: `dropbox://<folder>` backs up into the app folder of your own Dropbox
(2 GB free, no credit card), with no SDK to install. `dropboxStorage()` uploads with
`files/upload` or a streamed upload session, supports range reads, conditional writes
(so the normal storage lock works), batched deletes and a free-space check, and retries
Dropbox's rate limits. `loginDropbox()` runs the PKCE login with a loopback redirect or a
pasted code and returns the refresh token for `MONGOSHIELD_DROPBOX_TOKEN`. See
docs/guides/dropbox.md.
