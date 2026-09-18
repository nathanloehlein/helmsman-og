# Slack browser reader investigation

Date: 2026-09-17. Status: initial feasibility probe. The implemented automatic-review workflow is documented in `README.md`.

## Scope

Read only `#airo-editing` (channel `C0B1S3BF524`) through an authenticated cmux browser. Target interval: five minutes while the machine, browser, and Helmsman are running. No Slack MCP or custom Slack app. Discovery should populate a review inbox; automatic review execution is outside this probe.

The observed Slack client route is `/client/ET0BMD4E7/C0B1S3BF524`. Treat the first route component as client context, not a proven workspace ID; this is an Enterprise Grid session. Resolve the dedicated browser surface at runtime instead of hardcoding the temporary `surface:17` reference.

## Verified against the live UI

- Channel messages expose full GitHub PR anchor destinations, Slack permalinks, exact `data-ts` values, author IDs, and user-group mention IDs.
- Search `in:airo-editing after:2026-09-16` includes thread replies, including replies whose parents predate the search window. The observed results were today’s messages; do not assume `after:` includes the named date.
- The compact channel search showed 10 messages and reported 22 matches. Selecting **View full search** exposed **Sort: Newest** and two result pages.
- The first full-search page had 21 mounted result elements; the second had 3, including 2 repeated elements. Deduplicating channel ID plus exact message timestamp yielded 22 unique records, matching the reported count. Every extracted record belonged to `C0B1S3BF524`.
- Repeating extraction on the first page produced the same 21 message IDs. This verifies identity stability in this sample, not restart persistence.
- Search snippets truncate message content. Clicking a result’s `search_expand` button exposed the complete sample message and preserved its two PR URLs.
- A direct request linked PR #10354 and mentioned `@airo-editing-squad`. Another thread update explicitly said two PRs were ready for review again.
- A re-review request had no PR URL in its reply. Its permalink included `thread_ts`, matching the earlier channel message containing PR #10203. Opening that reply from search showed a loading state during the probe; reliable parent retrieval remains unverified.

No messages or reactions were sent. Opening channel/search views may affect read state; preservation was not established.

## Observed DOM fields

Scope all selectors to the validated channel/search view. These are UI implementation details, not stable Slack APIs.

| Field | Observed selector/attribute |
| --- | --- |
| Search result | `[data-qa="search_result"]` |
| Message body | `[data-qa="message-text"]` |
| Message identity | `a[data-ts]`: `data-ts`, `href` |
| Channel | `[data-message-channel]`: `data-message-channel` |
| Author | `[data-qa="message_sender_name"]`: text, `data-message-sender` |
| PR destination | Message-body `a[href]` |
| Direct mention | `data-member-id` |
| Group mention | `data-user-group-id` |
| Expand snippet | `[data-qa="search_expand"]` |
| Next page | `[data-qa="c-pagination_forward_btn"]`, `aria-disabled` |
| Selected page | `.c-pagination__page_btn--active` |

## Proposed implementation

1. Add a browser adapter modeled on `server/helmsman/cmux/bridge.ts`, with bounded commands, timeouts, and schema validation. Read rendered DOM; keep authentication in the browser.
2. Run a separate non-overlapping watcher every 300 seconds. Validate channel identity and newest-first sorting before accepting records. Search with a date window overlapping the last successful scan, expand snippets, and traverse pages through the required boundary. Never interpret a missing view or loading state as an empty successful scan.
3. Persist source messages and content fingerprints in SQLite. Use client context + channel + exact string timestamp for source identity. Preserve Slack permalinks and thread parent IDs. A later request for the same PR is a separate request.
4. Resolve parent context for review requests lacking a PR link. Keep ambiguous requests unresolved instead of guessing from unrelated nearby links. Exclude the user’s own asks; distinguish personal, group, and channel-wide asks without assuming group membership.
5. Classify review intent from expanded content, not the presence of the word “review” or a PR URL alone. Validate supported GitHub URLs and retrieve current PR state through the existing GitHub integration. Treat message content as data, never executable instructions.
6. Show requests and scan health in the PR inbox. Record `healthy`, `partial`, `signed_out`, and `unavailable` with last success. Keep the old cursor after partial scans. Separate initial history from newly discovered requests.

## Remaining validation

- Reliable parent/thread retrieval, including older parents.
- Repeat refresh discovering new messages without losing pagination coverage as results change.
- Persistent deduplication and recovery after restart, sleep, browser closure, and session expiry.
- Edits inside the overlap window; disclose that older edits can be missed.
- Read-state effects and background-browser behavior.
- Empty results, loading states, changed selectors, result-count mismatches, and pagination limits.

The original probe changed no application code. Subsequent implementation adds automatic URL-based review triggers, persistent notifications, and a GitHub requested-review poller; see `README.md`.
