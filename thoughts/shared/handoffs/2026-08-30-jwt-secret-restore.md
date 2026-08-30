---
date: 2026-08-30
topic: Restore DOORSERVER_JWT_SECRET on the live VPS
tags: [deploy, jwt, admin, 503]
status: pending
---

## Symptom

The admin API returns `503 admin API disabled: DOORSERVER_JWT_SECRET is not set`
on every login attempt. The cause was a combination of:
- The .env file on /app/doorserver was lost between deploys (likely a
  volume churn or hand-edited deletion)
- The deploy workflow's `envs:` + `env:` + `${secrets.X}` pattern
  doesn't reach the SSH step's shell the way I assumed, so the
  .env file gets written empty on every push

## Immediate fix (SSH into the VPS)

```
echo 'DOORSERVER_JWT_SECRET=XJj8UarJaJ+e8lHm0fnANZg6OQ3u8UARmakBISOCyQcXKmo8mirRQ3/xLGRfASKN' > /app/doorserver/.env
chmod 600 /app/doorserver/.env
docker restart doorserver-doorserver-1
sleep 5
curl -fsS http://localhost:3010/api/door-repo/health
```

The secret value is the one currently in your local
`/Users/spot/Code/amiexpress-doorserver/.env`. If you generated
a new one via `gh secret set`, use that instead.

## Long-term fix (deploy workflow)

The latest commit on main (`9d2fc08`) puts the secret back in
the workflow as `envs: DOORSERVER_JWT_SECRET` — but this turns
out to NOT actually pass the secret value through; the SSH
step's shell sees the literal string "DOORSERVER_JWT_SECRET"
empty. The fix that actually works is to use the
`env: KEY: ${{ secrets.X }}` block form (the `envs:` list is
for forwarding the JOB's env, not the action's). But the
`env:` block form was rejected by GitHub's workflow runner
("workflow file issue") for reasons I couldn't determine from
the action output. The .env was never written successfully.

Until this is sorted, the manual SSH fix above is the path.
