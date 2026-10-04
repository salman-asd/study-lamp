# Deploying Study Lamp

## Rate limiting

`checkRateLimit` (src/lib/server/rateLimit.ts) keeps its counters in each serverless instance's memory, so the real limit is roughly the configured limit × the number of running instances, and it resets on a cold start; use Upstash Redis (or another shared store) as the upgrade path when you need a hard, global limit.
