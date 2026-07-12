const crypto = require('crypto');
const keychain = require('./keychain');

const ALGORITHM = 'aes-256-gcm';
const SALT_LEN = 32;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const ITERATIONS = 100000;
const KEY_LEN = 32;

async function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LEN, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function getMasterKey(salt) {
  const password = await keychain.getPassword();
  if (!password) throw new Error('Master password not found in keychain');
  return deriveKey(password, salt);
}

/**
 * Encrypts a string (e.g. JSON data) and returns a base64 encoded string
 */
async function encrypt(text) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await getMasterKey(salt);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  // Format: base64(salt + iv + tag + encrypted)
  const result = Buffer.concat([salt, iv, tag, encrypted]);
  return result.toString('base64');
}

/**
 * Decrypts a base64 encoded string back to the original text.
 */
async function decrypt(base64Data) {
  const data = Buffer.from(base64Data, 'base64');
  if (data.length < SALT_LEN + IV_LEN + AUTH_TAG_LEN) {
    throw new Error('Invalid encrypted data format');
  }
  
  const salt = data.subarray(0, SALT_LEN);
  const iv = data.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = data.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const encrypted = data.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  
  const key = await getMasterKey(salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encrypt,
  decrypt
};
