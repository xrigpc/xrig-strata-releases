#!/usr/bin/env node
// Prints qualify.py's result with what it qualified: the exact config.json and stack.json (SHA-256), the launch
// vertex-launch-plan made for them (its fingerprint), the vertex-launch-plan binary itself (SHA-256) and the unit
// properties and OOM scores measured on the running engine. assemble-release.js accepts the evidence only for
// those two documents.
// Usage: qualification-record.js RESULT_JSON ASSEMBLED_DIR PLAN_JSON VERTEX_LAUNCH_PLAN UNIT_JSON
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [resultPath, assembled, planPath, planner, unitPath] = process.argv.slice(2);
if (!unitPath) throw new Error('usage: qualification-record.js RESULT_JSON ASSEMBLED_DIR PLAN_JSON VERTEX_LAUNCH_PLAN UNIT_JSON');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const result = read(resultPath), plan = read(planPath);
const configSHA = sha(path.join(assembled, 'config.json'));
if (plan.config_sha256 !== configSHA) throw new Error('the launch plan is for another config.json');
Object.assign(result, {
  config_id: plan.config_id, config_version: plan.config_version, config_sha256: configSHA,
  stack: plan.stack, stack_sha256: sha(path.join(assembled, 'stack.json')),
  launch_fingerprint: plan.fingerprint, launch_plan_sha256: sha(planner), unit_properties: read(unitPath),
});
console.log(JSON.stringify(result));
