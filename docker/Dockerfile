# Production-образ Marketplace API (#28). Мультистейдж: збирає Debian із npm,
# запускає distroless без shell і без пакетного менеджера.
#
#   npm run image:build      # = docker build -f docker/Dockerfile --secret id=npm_token,src=.npm_token …
#
# Рядка `# syntax=` тут немає свідомо: `RUN --mount=type=secret` розуміє
# стандартний фронтенд Dockerfile, бо з Docker 23 BuildKit — будівник за
# замовчуванням. Директива лише пінить версію фронтенда, і за це платиться
# pull образу docker/dockerfile з Docker Hub на кожній холодній збірці.

# ── Стадія 1: залежності, збірка, прибирання dev-залежностей ─────────────────
FROM node:24-slim AS build
WORKDIR /app

# Маніфести окремим шаром і раніше за код: доки package-lock.json не змінився,
# наступний RUN береться з кешу.
COPY package.json package-lock.json ./

# Токен приватного реєстру живе лише на час цього RUN:
#   • secret змонтований у /run/secrets/npm_token, у шар не потрапляє;
#   • docker/npmrc приходить bind-mount-ом з контексту — теж не шар;
#   • NPM_TOKEN — змінна одного процесу. У `docker history` лишається текст
#     команди, тобто `$(cat …)`, а не значення.
# ARG NPM_TOKEN осів би в історії образу, а COPY .npmrc + rm наступним RUN — у
# байтах попереднього шару: rm лише додає whiteout, файл у шарі лишається.
#
# --ignore-scripts: для збірки потрібен лише tsc, а install-скрипти залежностей
# (postinstall, що качає бінарники) — найпоширеніший шлях supply-chain атаки.
# Це те саме правило, що allowBuilds у pnpm-workspace.yaml.
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=bind,source=docker/npmrc,target=/run/npmrc \
    --mount=type=cache,target=/root/.npm \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" \
    NPM_CONFIG_USERCONFIG=/run/npmrc \
    npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ── Стадія 2: рантайм ────────────────────────────────────────────────────────
# Distroless: лише node, glibc, CA-сертифікати й tzdata. Немає sh, apt, curl.
# Після RCE зловмиснику нічим виконати навіть `ls` — це головний виграш, а не
# розмір (на вимірі лекції distroless виграв у alpine лише 3,5 %).
# Тег :nonroot задає uid 65532, а версія Node — та сама мажорна, що в збірці.
FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Спеку валідатор читає в рантаймі (src/app.setup.ts) — відносно WORKDIR.
COPY openapi ./openapi

# Числом, а не `nonroot`: kubelet при runAsNonRoot не резолвить імена
# користувачів і відмовляє з CreateContainerConfigError.
USER 65532:65532
EXPOSE 3000

# ENV тут немає: конфіг і секрети приходять у рантаймі від оркестратора.
# ENV живе в конфігу образу, і `docker inspect` віддає його кожному, хто зробив pull.

# Exec-форма через сам node — shell для HEALTHCHECK у distroless немає.
# Kubernetes цю інструкцію ігнорує (там проби робить kubelet), вона для `docker run`.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# ENTRYPOINT образу вже ["/nodejs/bin/node"], тому CMD — це аргументи до нього.
# Node — PID 1 і отримує SIGTERM напряму; обробник — у src/main.ts.
CMD ["dist/main.js"]
