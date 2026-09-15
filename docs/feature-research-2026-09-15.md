# Dashboard feature comparison — 2026-09-15

Inspected public project READMEs and compared them with the local dashboard.
Features were implemented locally; no third-party implementation was copied.

| Source | Useful feature | Decision |
| --- | --- | --- |
| [Codbash](https://github.com/vakovalskii/codbash) | Agent/date filters, labels, replay, deep search | Added AI and recent-activity filters to all/favorites/running lists. Labels, replay and indexed deep search remain candidates. |
| [Agent Quest](https://github.com/FulAppiOS/Agent-Quest) | Notifications and agent attention indicators | Added bounded notification inbox, unread count, session navigation and opt-in desktop notifications. |
| [Command Center](https://github.com/austinginder/command-center) | Cross-session search and active-time reporting | Future candidates; need an indexed background scan and well-defined idle accounting. |

## Delivered behavior

- Claude/Codex filter plus today, rolling 7-day and rolling 30-day activity windows.
  Today uses the browser's local midnight; dates use session `mtime` (latest activity).
  Selection persists in this browser. Reset clears filters and the text query.
- Inbox takes events from the existing SSE stream; no added polling or log scans.
  It keeps 50 alerts per page, ignores repeated event identities and excludes subagent events.
  Initial snapshot entries are history (read), not new desktop notifications.
  Reload restores only the server's retained event window; this is not a permanent archive.
- Desktop notifications default off and request permission only from the enable button.
  They are shown for new events while the dashboard tab is hidden. The banner contains
  the event category, not transcript text. Dashboard must stay open; hooks must be active.
- Existing terminal is selected if available, otherwise the session transcript is opened.
- Codex PermissionRequest and Interrupt now update browser-derived live state consistently.

## Browser API reference

[MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API):
permission requests belong in a user gesture. Denied or unsupported permissions leave
the in-app inbox usable. Operating system notification settings may suppress banners.
