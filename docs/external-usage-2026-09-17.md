# External service usage — September 17, 2026

Measured Helmsman server requests from 13:31:05 to 13:36:34 PDT (329 seconds):

| Service | Started | Failed / rate-limited |
| --- | ---: | ---: |
| GitHub REST | 86 | 0 |
| Jira | 36 | 0 |
| Total | 122 | 0 |

The sample includes active page loads (including a test Config tab), cold caches,
and the completion/publication of PR #10357. It is an observed workload sample,
not an idle rate or a reliable hourly forecast. The lightweight context bootstrap
was added after this sample to remove external dashboard reads when opening
Config, Runs, or cmux.

The counter subscribes to Node Undici request diagnostics, after cache lookup,
and excludes loopback/private services. It records origins and counters only.
Live counts: `GET /api/usage/external`. Counters reset when the server restarts.

A separate GitHub core-quota check rose from 393 to 471 used requests between
13:32:04 and 13:37:12 PDT: 78 calls across all clients sharing that quota, including
the ending measurement request. This is a different interval and scope from the
server counters; the two totals must not be added together. The ending remaining
quota was 4,529 of 5,000.

Slack uses its authenticated browser, not a server API. In a separate 308-second
sample the browser recorded 267 resource entries across Slack API, image, emoji,
CDN, and telemetry origins. Resource entries can include cache-served assets and
exclude WebSocket messages; they are not a trustworthy HTTP-call count. WKWebView
does not expose network request enumeration through cmux. The configured reader
runs once every five minutes, or 12 scans/hour.

Git CLI subprocesses and review-agent/model requests are outside the server meter.
The sample therefore does not claim to measure every external request from the
machine or every model invocation.

After deploying the lightweight context endpoint, a fresh Config load was verified
against the running server: the outbound counter stayed at 1 before and after
(the startup GitHub watcher request). Config requested only `/api/context`,
`/api/agents`, `/api/config`, and `/api/slack`: zero new GitHub or Jira requests.
