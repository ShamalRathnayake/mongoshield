---
"@mongoshield/console": minor
---

Live data browsing and editing. Connections get a live data browser (databases →
collections → documents with Extended JSON filters, projections and sorts, paging,
explain-free counts, collection stats and indexes), read-only by default for operators.
Editing is opt-in: an admin turns on "Allow live edits" per connection (production
connections need the name typed again and a recorded reason) and grants the new
`data:write` permission per user. Every write is backed by MongoShield: it is conditional
on the document not having changed since it was loaded (version check plus a
compare-and-swap filter), its pre-image is stored first in a sealed live edit journal in
the connection's journal storage (or the data directory), it can be undone (conditionally)
from the new Edit history page, and it is audited with before/after hashes. Edits show a
field-level diff and keep the BSON type of untouched fields; insert, duplicate and delete
one are supported, and "update many" / "delete many" need a preview count, a typed
confirmation and a per-connection cap, and run as `live-edit` jobs. No commands, shell or
server-side JavaScript are ever run.
