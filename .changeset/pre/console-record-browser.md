---
"@mongoshield/console": minor
---

A record browser to rival Compass, for live data and backups alike:

- A navigation tree of connections, databases and collections (type icons for views,
  time series and capped collections, counts, search, keyboard navigation), breadcrumbs,
  and the last opened collection remembered.
- Six views, remembered per collection: a table (flattened nested fields, column picker,
  reorder, resize, server-side sort, type-aware cells, virtualized rows), an expandable
  tree with type badges and copy actions, syntax-highlighted relaxed or canonical
  Extended JSON, summary cards, a schema of a sample (types, presence, values,
  histograms) and a simple chart.
- Querying made simple: field name suggestions, sort and projection pickers, quick
  filters from any value, filter chips, a per-collection query history, and cancelling a
  slow query.
- A document detail panel with previous/next, copy as JSON and the edit actions.
- Export of the current result as JSON, JSON Lines or CSV (new bounded, audited
  endpoints), and new sample endpoints for the schema view.
- Atlas Free/Flex aware: refused size statistics show as "—" with the reason, samples
  are smaller, and background queries are paced per connection.
- A refreshed design system (spacing and type scales, color tokens for both themes,
  consistent buttons, inputs, tables, badges, skeleton loaders and toasts) across the
  console.
