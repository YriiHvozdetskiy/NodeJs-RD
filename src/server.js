'use strict';

const app = require('./app');

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`Marketplace API → http://localhost:${PORT}/v1`);
  console.log('Валідація запитів і відповідей проти openapi/openapi.yaml: увімкнена');
  if (process.env.DRIFT === '1') {
    console.log('DRIFT=1 — сервер навмисно віддає totalCents замість total_cents');
  }
});
