#!/usr/bin/env node
// Starts the 5 inventory backend instances on localhost:3001-3005 (for running the gateway outside Docker
// with SERVICES_CONFIG=config/services.local.json). Needs Postgres: docker compose up -d postgres
// and `npm install` in services/backend once.
const { spawn } = require('child_process');
const path = require('path');

const instances = [
  ['inventory', 'inventory-1', 3001], ['inventory', 'inventory-2', 3002], ['inventory', 'inventory-3', 3003],
  ['stock', 'stock-1', 3004], ['stock', 'stock-2', 3005],
];
const server = path.join(__dirname, '..', 'services', 'backend', 'server.js');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://gateway:gateway@localhost:5433/gateway';
const children = instances.map(([service, id, port]) =>
  spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL, SERVICE_NAME: service, INSTANCE_ID: id, PORT: String(port) },
  })
);
const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
