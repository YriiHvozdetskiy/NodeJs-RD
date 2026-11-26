#!/usr/bin/env bash
# Який digest просувати в prod (#32, deploy.yml): той, що зібрав і перевірив PR.
#
#   GH_TOKEN=… EVENT=push|workflow_dispatch SHA=<коміт main> PR=<номер, для dispatch> \
#     bash scripts/ci/resolve-digest.sh
#
# Build once, promote by digest: у джобі деплою образ не збирається. Ланцюжок:
#   коміт main → PR, який його приніс → голова PR → успішний прогін ci.yml на
#   ній → артефакт pipeline-evidence → built-digest і image-ref.
# Пряма відповідь «що поїде в prod» — рівно ті байти, на яких PR пройшов гейти
# і demo:rollout. Прямий push у main без PR не має такого прогону — і не деплоїться.
#
# Пише в $GITHUB_OUTPUT: digest, image-repo, pr, source-run.
set -euo pipefail
REPO="${GITHUB_REPOSITORY:?}"

if [ "${EVENT:?}" = "workflow_dispatch" ]; then
  pr="${PR:?для ручного запуску потрібен номер PR}"
else
  pr="$(gh api "repos/${REPO}/commits/${SHA:?}/pulls" --jq '[.[] | select(.merged_at != null)][0].number // empty')"
  [ -n "${pr}" ] || { echo "resolve: ${SHA} потрапив у main не через PR — перевіреного digest немає" >&2; exit 1; }
fi

head="$(gh api "repos/${REPO}/pulls/${pr}" --jq '.head.sha')"
run="$(gh api "repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${head}&status=success&event=pull_request" \
        --jq '.workflow_runs[0].id // empty')"
[ -n "${run}" ] || { echo "resolve: у PR #${pr} немає успішного прогону ci.yml на голові ${head}" >&2; exit 1; }

dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/promote.XXXXXX")"
gh run download "${run}" -R "${REPO}" -n pipeline-evidence -D "${dir}"
digest="$(sed -n 's/^built-digest=//p' "${dir}/evidence.txt")"
ref="$(sed -n 's/^image-ref=//p' "${dir}/evidence.txt")"
[[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "resolve: у прогоні ${run} немає built-digest" >&2; exit 1; }

echo "PR #${pr} → голова ${head} → прогін ${run} → ${digest}"
{
  echo "digest=${digest}"
  echo "image-repo=${ref%:*}"
  echo "pr=${pr}"
  echo "source-run=${run}"
} >> "${GITHUB_OUTPUT:?}"
