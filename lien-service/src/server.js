'use strict';
const { build } = require('./app');
const { seed } = require('./seed');

seed();
const port = Number(process.env.PORT || 3000);
build().listen(port, () => {
  console.log(`lien-service listening on http://localhost:${port}`);
});
