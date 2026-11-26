#!/usr/bin/env bash
# Сховище раннера (#32): секрети застосунку для одного прогону конвеєра.
#
#   bash scripts/ci/vault.sh        # у джобі деплою, перед npm run cluster:up
#
# Кластер у раннері живе хвилини й зникає разом із машиною, база в ньому
# порожня. Тому значення не беруться з GitHub Secrets і не копіюються з
# робочої машини: вони генеруються тут, на прогін, у ті самі файли secrets/,
# що створює `npm run db:up` (#11). Далі все йде звичним шляхом:
# scripts/with-secrets.sh kind → Pulumi → K8s Secret → под. Конвеєр не має
# доступу до сховища розробника і не потребує його — витікати з репозиторію нічому.
#
# Маскування: кожне значення реєструється в раннері (::add-mask::) — сирим і
# в base64, бо саме так воно лежить у K8s Secret. Усіх похідних форм так не
# закрити (base64 від REDIS_QUEUE_URL із паролем усередині — уже інший рядок),
# тому маскування тут — страховка, а захист — те, що жоден крок значень не друкує.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

umask 077
mkdir -p secrets
[ -f secrets/db_password ] || printf 'app-%s' "$(openssl rand -hex 16)" > secrets/db_password
[ -f secrets/redis_password ] || printf 'redis-%s' "$(openssl rand -hex 16)" > secrets/redis_password
[ -f secrets/pulumi_passphrase ] || printf 'pulumi-%s' "$(openssl rand -hex 16)" > secrets/pulumi_passphrase
# Пара ES256, kid і перець refresh-токенів — той самий генератор, що на #24.
node scripts/jwt-keys.mjs init dev >/dev/null

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  for f in db_password redis_password pulumi_passphrase jwt/dev/refresh_pepper; do
    value="$(cat "secrets/${f}")"
    echo "::add-mask::${value}"
    echo "::add-mask::$(printf '%s' "${value}" | base64 -w0)"
  done
fi

# Імена, не значення: що саме лежить у сховищі цього прогону.
find secrets -type f | sort | sed 's/^/vault-file=/'
