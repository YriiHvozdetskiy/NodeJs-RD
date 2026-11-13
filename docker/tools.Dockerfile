# Інструменти кластера без установки на машину (#28): kind + Pulumi CLI + docker CLI.
#
# Образ збирається сам при першому виклику scripts/bin/kind чи scripts/bin/pulumi
# (scripts/lib/tools.sh) і використовується лише тоді, коли kind / pulumi немає в
# системі. Грейдер зі своїми kind і pulumi цього образу не торкається.
#
# kind кластер не запускає — він лише командує Docker: «запусти kindest/node,
# прокинь порт». Тому достатньо дати контейнеру сокет Docker: вузол кластера стає
# сусіднім контейнером у тому самому Docker, а не вкладеним.

# docker CLI — kind викликає саме бінарник `docker`, а не Docker API.
FROM docker:29-cli AS docker-cli

# Pulumi CLI 3.272.0 = версія @pulumi/pulumi в infra/package.json; Node 22 — для
# ts-node, яким Pulumi виконує infra/index.ts.
FROM pulumi/pulumi-nodejs-22:3.272.0

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# kind v0.32.0 — з релізу, з перевіркою sha256 під обидві архітектури: бінарник
# із чужого сервера без звірки — найкоротший шлях до supply-chain атаки.
ARG TARGETARCH
ARG KIND_VERSION=v0.32.0
ARG KIND_SHA256_AMD64=50030de23cf40a18505f20426f6a8506bedf13c6e509244bd1fa9463721b0f54
ARG KIND_SHA256_ARM64=b92cd615e97585de8ddade28ed5cd7feb4248d717c233eea5b03c37298900f5d
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) sum="${KIND_SHA256_AMD64}" ;; \
      arm64) sum="${KIND_SHA256_ARM64}" ;; \
      *) echo "kind: немає збірки під ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/kind "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${TARGETARCH}"; \
    echo "${sum}  /usr/local/bin/kind" | sha256sum -c -; \
    chmod +x /usr/local/bin/kind

ENV PULUMI_SKIP_UPDATE_CHECK=true
