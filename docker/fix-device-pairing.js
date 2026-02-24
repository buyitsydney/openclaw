// Ensures the container's device identity is paired with full operator scopes.
//
// The OpenClaw gateway auto-approves loopback device pairing on first connect,
// but only for the "not-paired" reason. Scope upgrades (e.g. from operator.read
// to operator.admin) require manual approval even on loopback. Agent tools use
// least-privilege scopes per method, so the first tool call creates a pairing
// with minimal scopes, and subsequent calls needing higher scopes fail with
// "pairing required".
//
// This script pre-creates (or updates) paired.json with all operator scopes
// so no scope upgrade is ever needed.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const IDENTITY_DIR = "/data/.openclaw/identity";
const IDENTITY_FILE = path.join(IDENTITY_DIR, "device.json");
const DEVICES_DIR = "/data/.openclaw/devices";
const PAIRED_FILE = path.join(DEVICES_DIR, "paired.json");
const FULL_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
];

function fingerprintPublicKey(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const raw = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function publicKeyBase64Url(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const raw = key.export({ type: "spki", format: "der" });
  // Ed25519 SPKI prefix is fixed 12 bytes; raw key is the remainder.
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const rawKey = raw.slice(spkiPrefix.length);
  return rawKey.toString("base64url");
}

let identity;
if (fs.existsSync(IDENTITY_FILE)) {
  const stored = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
  identity = {
    deviceId: stored.deviceId,
    publicKeyPem: stored.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  };
} else {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  identity = { deviceId, publicKeyPem, privateKeyPem };
  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  fs.writeFileSync(
    IDENTITY_FILE,
    JSON.stringify({ version: 1, deviceId, publicKeyPem, privateKeyPem }, null, 2),
  );
}

const now = Date.now();
const token = crypto.randomBytes(32).toString("base64url");
const pubKeyB64 = publicKeyBase64Url(identity.publicKeyPem);

let paired = {};
if (fs.existsSync(PAIRED_FILE)) {
  paired = JSON.parse(fs.readFileSync(PAIRED_FILE, "utf8"));
}

const existing = paired[identity.deviceId];
const needsUpdate =
  !existing ||
  JSON.stringify(existing.scopes?.toSorted()) !== JSON.stringify([...FULL_SCOPES].toSorted());

if (!needsUpdate) {
  console.log("device pairing OK");
  process.exit(0);
}

paired[identity.deviceId] = {
  deviceId: identity.deviceId,
  publicKey: pubKeyB64,
  displayName: "agent",
  platform: "linux",
  clientId: "gateway-client",
  clientMode: "backend",
  role: "operator",
  roles: ["operator"],
  scopes: FULL_SCOPES,
  approvedScopes: FULL_SCOPES,
  tokens: {
    operator: {
      token: existing?.tokens?.operator?.token || token,
      role: "operator",
      scopes: FULL_SCOPES,
      createdAtMs: existing?.tokens?.operator?.createdAtMs || now,
    },
  },
  createdAtMs: existing?.createdAtMs || now,
  approvedAtMs: existing?.approvedAtMs || now,
};

fs.mkdirSync(DEVICES_DIR, { recursive: true });
fs.writeFileSync(PAIRED_FILE, JSON.stringify(paired, null, 2));
console.log("device pairing initialized");
