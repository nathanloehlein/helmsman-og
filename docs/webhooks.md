# Workflow webhooks

Webhook intake is disabled unless `HELMSMAN_WEBHOOK_SECRET` and `HELMSMAN_WEBHOOK_ROUTES` are set on the host. Routes are explicit JSON mappings to saved workflows:

```json
[{"repo":"owner/project","event":"issues","action":"opened","workflowRef":"coding@1"}]
```

GitHub sends POST requests to `/api/webhooks/github` with `X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event`. Signatures cover the exact raw body. The service rejects unsigned/oversized payloads, unconfigured galleons, unmatched event/action mappings, and a delivery ID reused with different bytes. PR mappings use `review@1`; issue mappings use `coding@1`. Payloads cannot select a different workflow or destination.

Deliveries persist before dispatch. Stable run IDs, capacity checks, and durable claims prevent duplicate execution and allow reconciliation after a crash during asynchronous launch preparation. The existing one-writer-per-galleon rule and pre-PR gates still apply. The local server binds loopback; configuring public ingress and its webhook secret is an operator decision, not an automatic deployment.
