---
name: mob-creation
description: Start and verify one mob session from a work brief.
---

1. Choose the job. Read `policy` for its class and species pool. Take the first
   species with no live mob; if all are live, use the first species with its
   next free suffix.
2. Take the next serial from the swarm counter. Never reuse a serial. Set the
   session title to `<tag> <serial>-<SPECIES>` (with the suffix when needed).
   Name sprites `<mob-id>.<ITEM>` using the policy item pool and suffix rules.
3. Fill in [brief-template.md](brief-template.md) on demand. Persist the dispatch
   envelope before launch. Keep each retry distinct. Pass the completed brief
   to the mob and record its SHA-256 digest.
4. Start the mob in cloud environment `{{setup.environment}}`. For sprites,
   never pin a model. Use the router default with `{{tiers.models.sprite.thinking}}`
   thinking.
5. Verify the start: require the mob to reply with its ID and the brief digest.
   If either differs or is missing, do not treat the mob as started.
