#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deployment sha" >&2; exit 2; }
root=/opt/zerowallscience-docs
web=/var/www/zerowallscience-web
data=/var/lib/zerowallscience-docs/data
nginx_dir=/etc/nginx/conf.d
compose="$root/compose"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo "deployment already running" >&2; exit 2; }
incoming="$root/incoming/$sha"
test -s "$incoming/image.tar.gz"
test -s "$incoming/site.tar.gz"
test -s "$incoming/docker-compose.production.yml"
test -s "$incoming/nginx/zerowallscience-web.https.conf"
test -s "$incoming/nginx/zerowallscience-web.http.conf"
test ! -e "$root/maintenance"
release="$sha-$(date -u +%Y%m%dT%H%M%S)"
backup="$root/backups/$release"
mkdir -p "$backup" "$web/releases/$release"
chmod 755 "$web/releases/$release"
cp "$nginx_dir"/zerowallscience-web.*.conf "$backup/"
cp "$compose/docker-compose.yml" "$backup/docker-compose.yml"
old_release="$(readlink "$web/current")"
old_sha="$(cat "$compose/.deployed-sha")"
[[ "$old_sha" =~ ^[0-9a-f]{40}$ ]]
maintenance=0
snapshot=0

compose_up() {
  DEPLOY_SHA="$1" docker compose --project-directory "$compose" -f "$compose/docker-compose.yml" up -d --force-recreate docs
}
wait_healthy() {
  for _ in $(seq 1 30); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' zerowallscience-docs)" == healthy ]]; then
      curl -fsS --max-time 10 http://127.0.0.1:13001/api/health >/dev/null && return 0
    fi
    sleep 2
  done
  return 1
}
rollback() {
  status=$?
  trap - ERR
  set +e
  echo "deployment failed; restoring this site only" >&2
  # 整个恢复期间保持维护状态，避免覆盖上线后的编辑。
  if (( maintenance )); then
    docker stop -t 30 zerowallscience-docs || exit 1
    if (( snapshot )); then
      mv "$data" "$backup/failed-data" || exit 1
      mkdir -p "$data"
      tar -xzf "$backup/data.tar.gz" -C "$data" || exit 1
    fi
    cp "$backup/docker-compose.yml" "$compose/docker-compose.yml" || exit 1
    cp "$backup"/zerowallscience-web.*.conf "$nginx_dir/" || exit 1
    ln -sfn "$old_release" "$web/current.rollback"
    mv -Tf "$web/current.rollback" "$web/current" || exit 1
    compose_up "$old_sha" && wait_healthy && nginx -t && systemctl reload nginx || exit 1
    printf '%s\n' "$old_sha" > "$compose/.deployed-sha"
    rm -f "$root/maintenance"
  fi
  exit "$status"
}
trap rollback ERR

# 镜像加载、静态产物解包放在维护窗口之前。
gzip -dc "$incoming/image.tar.gz" | docker load
tar -xzf "$incoming/site.tar.gz" -C "$web/releases/$release"
chmod -R a+rX "$web/releases/$release"
test -s "$web/releases/$release/index.html"
test -s "$web/releases/$release/en/index.html"
tar -czf "$backup/site.tar.gz" -C "$web" "$(readlink "$web/current")"

touch "$root/maintenance"
maintenance=1
docker stop -t 30 zerowallscience-docs
tar -czf "$backup/data.tar.gz" -C "$data" .
tar -tzf "$backup/data.tar.gz" >/dev/null
snapshot=1
cp "$incoming/docker-compose.production.yml" "$compose/docker-compose.yml"
compose_up "$sha"
wait_healthy
curl -fsS --max-time 10 http://127.0.0.1:13001/api/docs/tree >/dev/null
curl -fsS --max-time 10 http://127.0.0.1:13001/docs/overview >/dev/null
# 只接受本站两个明确的配置文件。
install -m 0644 "$incoming/nginx/zerowallscience-web.https.conf" "$nginx_dir/"
install -m 0644 "$incoming/nginx/zerowallscience-web.http.conf" "$nginx_dir/"
nginx -t
ln -sfn "releases/$release" "$web/current.new"
mv -Tf "$web/current.new" "$web/current"
systemctl reload nginx
printf '%s\n' "$sha" > "$compose/.deployed-sha"
rm -f "$root/maintenance"
trap - ERR

# 仅清理本站的版本目录和镜像，不执行全局 Docker 清理。
find "$web/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
find "$root/incoming" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
while read -r tag; do
  [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue
  [[ "$tag" == "$sha" || "$tag" == "$old_sha" ]] && continue
  if ! find "$web/releases" -mindepth 1 -maxdepth 1 -name "$tag*" | read -r _; then
    docker image rm "zerowallscience-docs:$tag" || true
  fi
done < <(docker images zerowallscience-docs --format '{{.Tag}}')
echo "deployed $sha"
