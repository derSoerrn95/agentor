# No Traefik in external mode, so dash.docker.localhost is never served:
# wait for the orchestrator directly.
READY_URL=http://localhost:3000/api/health
