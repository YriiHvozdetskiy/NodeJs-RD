import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { b64, type Backing } from './backing';
import type { Vault } from './vault';

export const API = 'marketplace-api';

/** Куди змонтовано пароль БД; застосунок читає його на кожне нове зʼєднання (#11). */
const DB_PASSWORD_DIR = '/var/run/secrets/marketplace/db';

/**
 * good — чотири налаштування, які дають нуль невдалих відповідей на rollout;
 * bad  — «як не треба»: без проб, maxUnavailable: 1, без дренажу. Існує, щоб
 * demo:rollout міг показати, що вимір відрізняє одне від іншого.
 */
export type Profile = 'good' | 'bad';

export interface ApiArgs {
  namespace: pulumi.Input<string>;
  image: string;
  replicas: number;
  profile: Profile;
  /** Ревізія pod-шаблону: її зміна і є rolling update (образ із тим самим тегом шаблону не змінює). */
  rev: string;
  nodePort: number;
  vault: Vault;
  backing: Backing;
}

export function deployApi(args: ApiArgs, opts: pulumi.CustomResourceOptions) {
  const { namespace, profile } = args;
  const good = profile === 'good';
  const labels = { app: API };

  // Усе оточення застосунку зі сховища — одним Secret. Імʼя з суфіксом від
  // Pulumi: новий вміст = новий Secret = нове імʼя в pod-шаблоні = rollout.
  // Інакше поди жили б зі старими значеннями до першого рестарту.
  const env = new k8s.core.v1.Secret(`${API}-env`, {
    metadata: { namespace, labels },
    type: 'Opaque',
    data: pulumi.secret(Object.fromEntries(Object.entries(args.vault.appEnv).map(([k, v]) => [k, b64(v)]))),
  }, opts);

  // Дренаж 5 с: readiness=503 → kubelet бачить це за ≤1 с (periodSeconds: 1) →
  // EndpointSlice → kube-proxy переписує правила. Grace 20 с > дренажу + close().
  const drainMs = good ? 5000 : 0;
  const terminationGracePeriodSeconds = good ? 20 : 30;

  // Типізований обʼєкт, а не умовний spread усередині контейнера: у spread
  // TypeScript не перевіряє зайвих полів, і одруківка `readinesProbe` пройшла б
  // tsc мовчки, а в кластер проба просто не доїхала б.
  const probes: Pick<k8s.types.input.core.v1.Container, 'startupProbe' | 'readinessProbe' | 'livenessProbe'> = good
    ? {
        // Поки startupProbe не зелена, liveness і readiness не виконуються.
        // 60 × 1 с на старт замість initialDelaySeconds у liveness: повільний
        // старт не вбиває под, а після старту liveness реагує за 30 с, а не за 30 + delay.
        startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 1, failureThreshold: 60 },
        // «Чи можна слати трафік»: 503 до першого зʼєднання з БД і з першої
        // миті після SIGTERM. Період 1 с — саме стільки под ще отримує трафік
        // після того, як сказав «ні».
        readinessProbe: { httpGet: { path: '/health/ready', port: 'http' }, periodSeconds: 1, failureThreshold: 1, timeoutSeconds: 1 },
        // «Чи треба мене вбити»: інший шлях. Liveness на /health/ready
        // перезапускала б под щоразу, коли він тимчасово не готовий, — і під
        // час дренажу теж.
        livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2 },
      }
    : {};

  const deployment = new k8s.apps.v1.Deployment(API, {
    metadata: { name: API, namespace, labels },
    spec: {
      // Поки в kind немає metrics-server, кількість реплік тримає це поле.
      // У бойовому кластері його пише ще й HPA — README, розділ Kubernetes.
      replicas: args.replicas,
      selector: { matchLabels: labels },
      strategy: {
        type: 'RollingUpdate',
        // maxUnavailable: 0 — старий под іде лише тоді, коли новий сказав «готовий».
        rollingUpdate: good ? { maxUnavailable: 0, maxSurge: 1 } : { maxUnavailable: 1, maxSurge: 1 },
      },
      template: {
        metadata: { labels },
        spec: {
          terminationGracePeriodSeconds,
          // fsGroup — щоб файл пароля з Secret (0440) читався uid 65532.
          securityContext: {
            runAsNonRoot: true,
            // Числом: distroless задає USER nonroot, а kubelet імена не резолвить.
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [{
            name: 'api',
            image: args.image,
            // Образ приходить через `kind load`, тягнути його нема звідки.
            imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'http', containerPort: 3000 }],
            env: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'PORT', value: '3000' },
              // Прогрів до listen(): без нього поганий профіль показав би нуль
              // збоїв лише тому, що застосунок стартує швидше, ніж встигає зламатись.
              { name: 'WARMUP_MS', value: '4000' },
              { name: 'DRAIN_MS', value: String(drainMs) },
              { name: 'DB_PASSWORD_FILE', value: `${DB_PASSWORD_DIR}/password` },
              // 4 репліки на rollout × 2 пули × 4 = 32 зʼєднання з max_connections 100.
              { name: 'DB_POOL_MAX', value: '4' },
              { name: 'REV', value: args.rev },
            ],
            // Значення зі сховища — лише посиланням на Secret.
            envFrom: [{ secretRef: { name: env.metadata.name } }],
            volumeMounts: [
              { name: 'db-password', mountPath: DB_PASSWORD_DIR, readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
            ],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            // requests потрібні HPA (утилізація CPU рахується від них) і щоб под
            // не був BestEffort — такого вузол виселяє першим.
            resources: { requests: { cpu: '100m', memory: '160Mi' }, limits: { memory: '384Mi' } },
            ...probes,
          }],
          volumes: [
            { name: 'db-password', secret: { secretName: args.backing.dbSecretName, defaultMode: 0o440, items: [{ key: 'password', path: 'password' }] } },
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
          ],
        },
      },
    },
  }, { ...opts, dependsOn: args.backing.ready });

  const service = new k8s.core.v1.Service(API, {
    metadata: { name: API, namespace, labels },
    spec: {
      type: 'NodePort',
      selector: labels,
      ports: [{ name: 'http', port: 80, targetPort: 'http', nodePort: args.nodePort }],
    },
  }, opts);

  // maxUnavailable: 1, а не minAvailable: N. minAvailable == replicas блокує
  // будь-який drain назавжди; а з HPA кількість реплік плаває, і minAvailable: 2
  // при HPA, що зменшив deployment до двох, — те саме блокування. maxUnavailable
  // рахується від поточного масштабу і лишає місце для обслуговування завжди.
  const pdb = new k8s.policy.v1.PodDisruptionBudget(API, {
    metadata: { name: API, namespace, labels },
    spec: { maxUnavailable: 1, selector: { matchLabels: labels } },
  }, opts);

  const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(API, {
    metadata: { name: API, namespace, labels },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name },
      minReplicas: 2,
      maxReplicas: 6,
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
    },
  }, opts);

  return { deployment, service, pdb, hpa };
}
