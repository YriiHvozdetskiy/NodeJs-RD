# ДЗ #3 — HTTP-сервер «з нуля» на `net` + HTTPS на `tls`

HTTP/1.1-сервер без фреймворків і **без модулів `http` / `https`**: сирі байти приймаються
з TCP-сокета, request-line та заголовки розбираються вручну, відповідь формується як текст.
HTTPS-варіант переюзає той самий обробник, змінюється лише транспорт.

Сторонніх npm-залежностей немає — тільки стандартна бібліотека Node (`net`, `tls`, `fs`).

## Вимоги

- Node.js ≥ 18 (розроблялось на v24.14.1)
- OpenSSL (для генерації самопідписаного сертифіката)

## Генерація самопідписаного сертифіката

Сертифікати **не комітяться** — `certs/`, `*.pem` і `*.key` у `.gitignore`.
Перед запуском HTTPS-сервера згенеруй їх із кореня репозиторію:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
```

`-addext "subjectAltName=DNS:localhost"` обовʼязковий: сучасні клієнти перевіряють імʼя
хоста за SAN і повністю ігнорують застарілий `CN`.

## Запуск

Обидві команди виконуються **з кореня репозиторію**, кожна у своєму терміналі:

```bash
node src/server.js         # HTTP  на http://localhost:3000
node src/https-server.js   # HTTPS на https://localhost:3443
```

Сервери незалежні — можна піднімати обидва одночасно.

## Роути

| Запит | Відповідь |
|---|---|
| `GET /` | `200 OK`, `Content-Type: text/plain; charset=utf-8` |
| `GET /headers` | `200 OK`, тіло — розібрані заголовки запиту (ключі в lower-case) |
| будь-що інше | `404 Not Found` |

## Перевірка

```bash
# HTTP
curl -sv http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/nope     # 404
curl -s http://localhost:3000/headers -H "X-Demo: abc"                  # host: / x-demo: abc

# HTTPS (-k — сертифікат самопідписаний, тому не перевіряємо ланцюг)
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3443/        # 200
```

Кадрування перевіряється запитом, розрізаним на два TCP-пакети — сервер має дочекатися
повних заголовків, а не відповісти на половину:

```bash
{ printf 'GET / HTTP/1.1\r\nHost: '; sleep 1; printf 'localhost\r\n\r\n'; } | nc localhost 3000
```

## Структура

| Файл | Призначення |
|---|---|
| `src/server.js` | raw HTTP на `net`; експортує `parseRequest`, `handle`, `serialize`, `onConnection` |
| `src/https-server.js` | HTTPS на `tls`; переюзає `onConnection` із `server.js` |

`server.js` піднімає сервер лише коли запущений напряму (`import.meta.main`) — тому
`import` із нього не має побічних ефектів, і `node src/https-server.js` не займає порт 3000.

## Debug-сесія: `openssl s_client`

```bash
openssl s_client -connect localhost:3443 -servername localhost </dev/null
```

```
Connecting to ::1
depth=0 CN=localhost
verify error:num=18:self-signed certificate
verify return:1
depth=0 CN=localhost
verify return:1
CONNECTED(00000005)
---
Certificate chain
 0 s:CN=localhost
   i:CN=localhost
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Aug  8 17:09:12 2026 GMT; NotAfter: Aug  8 17:09:12 2027 GMT
---
Server certificate
-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUPvFS9HG3vKsQeO6pFedLvQRRqiAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgwODE3MDkxMloXDTI3MDgw
ODE3MDkxMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAuR1uJHtp2Uz1LKQZayxLoyB2SI1JAEWq26TpYq+LSno4
d+YU4LuUV162YgPcD2YilhckaaGI8w+tFcnSaZCYCHEyMJHznSWy1gNqJo+25InP
Q5dXioPzRDXchS4+kb9LzJwP8+p7R/4+LSkDhzlsQIooLFSnvUjTFqS+XTRmMCJ0
Yqky1ucSePLkV0vRvO5RRILhSwiR8buoysQxc+MRjyEL5Wqou7KoutIvRnKwcKyK
lkvqeZfMHpMOHY6sbThX5ZziGCPV5pni4ai30XUxjXzAX28eWi3SK9jVpQM5f5LR
Cz2kdcF79ERAV5vm5Q3xWapMQscnekA88wi4Pz54fQIDAQABo2kwZzAdBgNVHQ4E
FgQUp3Q9xgKdOQiLOm5TBR7taxk/1CgwHwYDVR0jBBgwFoAUp3Q9xgKdOQiLOm5T
BR7taxk/1CgwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAASdvtfWqsURUCr+yWL568C5uobAG7yM9CrEE5f3
faNHQI8jCcf56VAPKzv7+i8B+3yF8HX5Ecv2LtK1tAtnelh41RC5LuVrJQM167PL
w+uh6lcOhMRUiGt6ZGSogyCDOI2Ug6ukhXI487jqpM4tN+44YSNg3CpvlZUhTX+0
dCHCfj1sPKmuAI5HjaRkuzirMQHyWi8RMDSHwCRM2XiSn44PHNcm9aWcypEGrAC0
xluArpAmDZixFTUYGf5zgj0bE3GgPBMXHcT5LpI/q3ZJ9FC5BIvbndgedsXIyX1b
EAVGcYI5Gl6PBcA0Kzcbv+/FmwifY35T9EHiYRWwUhy+674=
-----END CERTIFICATE-----
subject=CN=localhost
issuer=CN=localhost
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: rsa_pss_rsae_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 2447 bytes and written 1622 bytes
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 2048 bit
This TLS version forbids renegotiation.
Compression: NONE
Expansion: NONE
No ALPN negotiated
Early data was not sent
Verify return code: 18 (self-signed certificate)
---
DONE
```

**Що означає `verify error:num=18`:**

код 18 — self-signed certificate: сертифікат підписаний власним приватним ключем.
У виводі це видно одразу — `Certificate chain` містить рівно один елемент, у якому
`s:` (subject) збігається з `i:` (issuer): `CN=localhost`. Вести ланцюг далі нема куди,
а самого сертифіката немає в системному сховищі довірених коренів — тож OpenSSL нічим
підтвердити, що його видав хтось, кому клієнт довіряє.

Попри помилку перевірки, сам TLS-канал встановлено: `Protocol: TLSv1.3`,
`Cipher is TLS_AES_256_GCM_SHA384`. Тобто конфіденційність і цілісність трафіку є —
немає лише третьої гарантії TLS, автентичності сервера.

### Інші коди `Verify return code`

| Код | Значення | Типова причина |
|---|---|---|
| 0 | ланцюг валідний | — |
| 10 | certificate has expired | прострочений `notAfter` |
| 18 | self-signed certificate | dev-сертифікат; у проді — брати від CA |
| 19 | self-signed certificate in chain | самопідписаний корінь у ланцюгу |
| 20 / 21 | unable to get local issuer / verify first cert | не долучено intermediate — у браузері працює, з `curl` падає |
