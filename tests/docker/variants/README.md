# Test stack variants

Some behaviour only exists under an orchestrator configuration the default
test stack does not use (and cannot use without breaking other tests). A
variant changes that configuration for one run:

```bash
cd tests
TEST_STACK_VARIANT=<name> npm run test:docker -- --project=api <spec>
```

- `<name>.yml` (optional) is layered over `stack.yml` with `docker compose -f`.
- `<name>.sh` (optional) is sourced by `test-entrypoint.sh` after the images are
  built and right before the stack starts. It can use `log`, `stack_compose`
  and override `READY_URL` (default `https://dash.docker.localhost/api/health`).

Specs that need a variant skip themselves unless `TEST_STACK_VARIANT` names it,
so the default run stays unchanged.
