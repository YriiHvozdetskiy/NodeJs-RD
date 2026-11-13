import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import type { Vault } from './vault';

/**
 * Те, без чого API не стартує: Postgres і Redis черги (денилист access-токенів,
 * #24), плюс міграції Job-ом. Лише для локального kind: дані в emptyDir і
 * живуть, доки живе под. На #31 на їхньому місці буде RDS, а DB_URL зі сховища
 * вказуватиме туди — програма API від цього не зміниться.
 *
 * Брокер, кеш і сховище файлів сюди не їдуть: застосунок уміє без них
 * (порожні SWITCHABLE у vault.ts), а пам'ять вузла kind спільна з усім іншим.
 */
export const DB_SERVICE = 'marketplace-db';
export const REDIS_SERVICE = 'marketplace-redis';

export interface BackingArgs {
  namespace: pulumi.Input<string>;
  image: string;
  vault: Vault;
}

export interface Backing {
  /** Secret із паролем БД: його читають Postgres, Job міграцій і API (файлом). */
  dbSecretName: pulumi.Output<string>;
  /** Від чого має залежати API: схема накочена, Redis готовий. */
  ready: pulumi.Resource[];
}

export function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function deployBacking(args: BackingArgs, opts: pulumi.CustomResourceOptions): Backing {
  const { namespace, vault } = args;

  // Secret через `data` у base64, а не `stringData`: stringData — поле лише для
  // запису, API його не повертає, і провайдер бачив би різницю на кожному up.
  // pulumi.secret — щоб значення лежало в стані Pulumi зашифрованим passphrase.
  const dbSecret = new k8s.core.v1.Secret('marketplace-db', {
    metadata: { namespace, labels: { app: DB_SERVICE } },
    type: 'Opaque',
    data: pulumi.secret({ password: b64(vault.dbPassword) }),
  }, opts);

  const redisSecret = new k8s.core.v1.Secret('marketplace-redis', {
    metadata: { namespace, labels: { app: REDIS_SERVICE } },
    type: 'Opaque',
    data: pulumi.secret({ password: b64(vault.redis.password) }),
  }, opts);

  // ── Postgres ──────────────────────────────────────────────────────────────
  const dbLabels = { app: DB_SERVICE };
  const db = new k8s.apps.v1.Deployment(DB_SERVICE, {
    metadata: { name: DB_SERVICE, namespace, labels: dbLabels },
    spec: {
      replicas: 1,
      // Recreate: два Postgres на одних даних не можна навіть на секунду.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: dbLabels },
      template: {
        metadata: { labels: dbLabels },
        spec: {
          containers: [{
            name: 'postgres',
            image: 'postgres:17-alpine',
            imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'postgres', containerPort: 5432 }],
            env: [
              // Власник бази — користувач із DB_URL: у kind міграції й застосунок
              // ходять одним користувачем (ролі admin/app_user — лише в compose).
              { name: 'POSTGRES_USER', value: vault.db.user },
              { name: 'POSTGRES_DB', value: vault.db.database },
              { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: dbSecret.metadata.name, key: 'password' } } },
              { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
            ],
            // По TCP, а не через сокет: під час initdb тимчасовий сервер слухає
            // лише unix-сокет, і готовим под ставав би посеред ініціалізації.
            readinessProbe: {
              exec: { command: ['pg_isready', '-h', '127.0.0.1', '-U', vault.db.user, '-d', vault.db.database] },
              periodSeconds: 2,
              failureThreshold: 30,
            },
            resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
            volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
          }],
          volumes: [{ name: 'data', emptyDir: {} }],
        },
      },
    },
  }, opts);

  const dbService = new k8s.core.v1.Service(DB_SERVICE, {
    metadata: { name: DB_SERVICE, namespace, labels: dbLabels },
    spec: { selector: dbLabels, ports: [{ name: 'postgres', port: vault.db.port, targetPort: 'postgres' }] },
  }, opts);

  // ── Redis черги ───────────────────────────────────────────────────────────
  const redisLabels = { app: REDIS_SERVICE };
  const redis = new k8s.apps.v1.Deployment(REDIS_SERVICE, {
    metadata: { name: REDIS_SERVICE, namespace, labels: redisLabels },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: redisLabels },
      template: {
        metadata: { labels: redisLabels },
        spec: {
          containers: [{
            name: 'redis',
            image: 'redis:8.10.2-alpine',
            imagePullPolicy: 'IfNotPresent',
            // $(REDIS_PASSWORD) підставляє kubelet зі змінної контейнера нижче;
            // у маніфесті лежить посилання на Secret, а не пароль.
            command: ['redis-server', '--save', '', '--appendonly', 'no', '--requirepass', '$(REDIS_PASSWORD)'],
            env: [{ name: 'REDIS_PASSWORD', valueFrom: { secretKeyRef: { name: redisSecret.metadata.name, key: 'password' } } }],
            ports: [{ name: 'redis', containerPort: 6379 }],
            readinessProbe: { tcpSocket: { port: 'redis' }, periodSeconds: 2 },
            resources: { requests: { cpu: '20m', memory: '16Mi' }, limits: { memory: '128Mi' } },
          }],
        },
      },
    },
  }, opts);

  const redisService = new k8s.core.v1.Service(REDIS_SERVICE, {
    metadata: { name: REDIS_SERVICE, namespace, labels: redisLabels },
    spec: { selector: redisLabels, ports: [{ name: 'redis', port: vault.redis.port, targetPort: 'redis' }] },
  }, opts);

  // ── Міграції ──────────────────────────────────────────────────────────────
  // Job, а не initContainer: при initContainer три репліки накочували б схему
  // одночасно. Імʼя без metadata.name — Pulumi додає суфікс і на зміні образу
  // замінює Job новим (шаблон Job незмінний). Pulumi чекає, поки Job завершиться,
  // і лише тоді створює Deployment API (dependsOn нижче).
  const migrate = new k8s.batch.v1.Job('marketplace-migrate', {
    metadata: { namespace, labels: { app: 'marketplace-migrate' } },
    spec: {
      backoffLimit: 4,
      template: {
        metadata: { labels: { app: 'marketplace-migrate' } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532 },
          containers: [{
            name: 'migrate',
            image: args.image,
            imagePullPolicy: 'IfNotPresent',
            // ENTRYPOINT образу — node, тож це `node node_modules/typeorm/cli.js …`.
            args: ['node_modules/typeorm/cli.js', 'migration:run', '-d', 'dist/data-source.js'],
            // CLI читає DB_* (src/db/cli-env.ts), а не DB_URL.
            env: [
              { name: 'DB_HOST', value: vault.db.host },
              { name: 'DB_PORT', value: String(vault.db.port) },
              { name: 'DB_USER', value: vault.db.user },
              { name: 'DB_NAME', value: vault.db.database },
              { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: dbSecret.metadata.name, key: 'password' } } },
            ],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { memory: '256Mi' } },
          }],
        },
      },
    },
  }, { ...opts, dependsOn: [db, dbService] });

  return { dbSecretName: dbSecret.metadata.name, ready: [migrate, redis, redisService] };
}
