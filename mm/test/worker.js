// Rinnakkainen asiakas: odottaa yhteistä lähtömerkkiä ja lähettää yhden pyynnön.
const { workerData, parentPort } = require("worker_threads");
const { fileEnv } = require("./fileenv.js");

const env = fileEnv(workerData.dir, { clock: workerData.clock, noLock: workerData.noLock, slowRead: workerData.slowRead });
const gate = new Int32Array(workerData.gate);
Atomics.add(gate, 1, 1);
Atomics.wait(gate, 0, 0); // kaikki lähtevät samaan aikaan
const res = env.server.handle(workerData.body);
parentPort.postMessage({ ok: res.ok, error: res.error || null, result: res.result || null, replay: !!res.replay });
