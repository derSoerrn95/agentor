# Seed the private registry of variants/registry.yml. Sourced by
# test-entrypoint.sh after the agentor images are built.
REG_DIR=/opt/test-registry
REG_USER=agentor
REG_PASS=agentor-test-registry-pw
REG_HOSTS="registry.localhost:5443 registry2.localhost:5443"

mkdir -p "$REG_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=registry.localhost" \
    -addext "subjectAltName=DNS:registry.localhost,DNS:registry2.localhost" \
    -keyout "$REG_DIR/registry.key" -out "$REG_DIR/ca.crt" 2>/dev/null
chmod 644 "$REG_DIR/registry.key"
# The inner dockerd trusts the cert per registry host.
for h in $REG_HOSTS; do
    mkdir -p "/etc/docker/certs.d/$h"
    cp "$REG_DIR/ca.crt" "/etc/docker/certs.d/$h/ca.crt"
done
# registry:2 only accepts bcrypt htpasswd entries.
docker run --rm --entrypoint htpasswd httpd:2.4-alpine -Bbn "$REG_USER" "$REG_PASS" > "$REG_DIR/htpasswd"
# Credentials for registry2.localhost ONLY, in docker's config.json format —
# so the orchestrator image check can only succeed through that source.
printf '{"auths":{"registry2.localhost:5443":{"auth":"%s"}}}\n' \
    "$(printf '%s:%s' "$REG_USER" "$REG_PASS" | base64 -w0)" > "$REG_DIR/docker-config.json"

stack_compose up -d registry
for _ in $(seq 1 60); do
    # 401 = up and enforcing auth
    [ "$(curl -sk -o /dev/null -w '%{http_code}' https://registry.localhost:5443/v2/)" = "401" ] && break
    sleep 1
done

echo "$REG_PASS" | docker login registry.localhost:5443 -u "$REG_USER" --password-stdin > /dev/null
for img in agentor-worker agentor-orchestrator; do
    docker tag "$img:latest" "registry.localhost:5443/$img:latest"
    docker push -q "registry.localhost:5443/$img:latest" > /dev/null
    # Drop the registry tag again: the orchestrator has to pull it itself,
    # with its own credentials.
    docker rmi "registry.localhost:5443/$img:latest" > /dev/null
done
# Leave no credentials in the runner's docker CLI: every pull from here on
# is the orchestrator's, authenticated or not.
docker logout registry.localhost:5443 > /dev/null
log "Private registry seeded (agentor-worker, agentor-orchestrator)."
