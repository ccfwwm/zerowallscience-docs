#!/usr/bin/env bash
set -Eeuo pipefail
sha="$1"; [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deployment sha" >&2; exit 2; }
root=/opt/zerowallscience-docs; web=/var/www/zerowallscience-web; compose="$root/compose"
test -s "$root/incoming/$sha/image.tar.gz"; test -s "$root/incoming/$sha/site.tar.gz"
mkdir -p "$root/backups/$sha" "$web/releases/$sha" /var/lib/zerowallscience-docs/{data,backups}
cp /etc/nginx/conf.d/zerowallscience-web.*.conf "$root/backups/$sha/"
old_release="$(readlink "$web/current" || true)"; old_sha="$(cat "$compose/.deployed-sha" 2>/dev/null || true)"
rollback() {
  cp "$root/backups/$sha/"zerowallscience-web.*.conf /etc/nginx/conf.d/ || true
  if [[ -n "$old_release" ]]; then ln -sfn "$old_release" "$web/current.rollback"; mv -Tf "$web/current.rollback" "$web/current"; fi
  if [[ "$old_sha" =~ ^[0-9a-f]{40}$ ]]; then DEPLOY_SHA="$old_sha" docker compose --project-directory "$compose" -f "$compose/docker-compose.yml" up -d || true; fi
  nginx -t && systemctl reload nginx || true
}
trap rollback ERR
gzip -dc "$root/incoming/$sha/image.tar.gz" | docker load
tar -xzf "$root/incoming/$sha/site.tar.gz" -C "$web/releases/$sha"
cp "$root/incoming/$sha/docker-compose.production.yml" "$compose/docker-compose.yml"
DEPLOY_SHA="$sha" docker compose --project-directory "$compose" -f "$compose/docker-compose.yml" up -d
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:13001/api/health >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:13001/api/health >/dev/null
install -m 0644 "$root/incoming/$sha/nginx/"*.conf /etc/nginx/conf.d/
nginx -t
ln -sfn "releases/$sha" "$web/current.new"; mv -Tf "$web/current.new" "$web/current"
systemctl reload nginx
curl -fsS -H 'Host: zerowallscience.org' http://127.0.0.1:13001/api/docs/tree >/dev/null
printf '%s\n' "$sha" > "$compose/.deployed-sha"
trap - ERR
find "$web/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
find "$root/incoming" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
