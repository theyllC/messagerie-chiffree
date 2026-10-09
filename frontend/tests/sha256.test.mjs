// Lancer : node frontend/tests/sha256.test.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256Hex } from "../src/sha256.js";

const ref = (t) => createHash("sha256").update(t, "utf8").digest("hex");
assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
// toutes les longueurs autour des frontières de bloc (55, 56, 63, 64, 119, 120…) + texte accentué
for (let n = 0; n < 300; n++) assert.equal(sha256Hex("a".repeat(n)), ref("a".repeat(n)), `longueur ${n}`);
for (let i = 0; i < 200; i++) { const t = randomBytes(1 + (i % 90)).toString("base64") + "é✋🪨"; assert.equal(sha256Hex(t), ref(t)); }
console.log("OK   SHA-256 identique à node:crypto (300 longueurs + 200 textes aléatoires)");
